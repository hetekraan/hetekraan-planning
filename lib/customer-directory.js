/**
 * Gedeelde helpers voor de Klanten-pagina (Merge 2).
 *
 * Bronnen:
 *  - GHL contacten (gerichte `?query=` search, geen bulk-scan)
 *  - Moneybird contacten (`listContacts({ query })`)
 *  - Supabase `appointment_snapshots` (echte historie vanaf snapshot-deploy)
 *  - GHL contact custom fields (legacy "laatste afgeronde afspraak" fallback)
 *  - Redis Model B reserveringen (geplande/toekomstige afspraken)
 */
import { fetchWithRetry } from './retry.js';
import { ghlLocationIdFromEnv } from './ghl-env-ids.js';
import { listContacts as listMoneybirdContacts } from './moneybird.js';
import { readCanonicalAddressLine } from './ghl-contact-canonical.js';
import { readContactCustomFieldById } from './planning/appointment.js';
import { BOOKING_FORM_FIELD_IDS, toPriceNumber } from './booking-canon-fields.js';
import { LEGACY_COMPLETE_FIELD_IDS } from './usecases/complete-appointment.js';
import { listReservationsForContact } from './block-reservation-store.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY;

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

function toText(v) {
  const s = String(v ?? '').trim();
  return s && s.toLowerCase() !== 'null' ? s : '';
}

function normalizeEmail(v) {
  return String(v ?? '').trim().toLowerCase();
}

function normalizePhoneKey(v) {
  return String(v ?? '').replace(/[^\d]/g, '').replace(/^0+/, '');
}

function fullName(parts = []) {
  return parts.map((x) => toText(x)).filter(Boolean).join(' ').trim();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const t = toText(v);
    if (t) return t;
  }
  return '';
}

function isYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
}

function ymd(v) {
  const s = String(v || '').trim();
  if (isYmd(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  return m ? m[1] : '';
}

export function getCustomerDirectoryEnv() {
  const locationId = String(ghlLocationIdFromEnv() || '').trim();
  const hasGhl = !!(GHL_API_KEY && locationId);
  const hasSb = !!(String(process.env.SUPABASE_URL || '').trim() && String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
  const hasMb = !!(process.env.MONEYBIRD_API_TOKEN && process.env.MONEYBIRD_ADMINISTRATION_ID);
  return { locationId, hasGhl, hasSb, hasMb };
}

// ─── GHL ────────────────────────────────────────────────────────────────────

function mapGhlContactCard(c = {}) {
  const name = firstNonEmpty(c.name, fullName([c.firstName, c.lastName])) || 'Onbekend';
  return {
    contactId: toText(c.id),
    source: 'ghl',
    name,
    email: normalizeEmail(c.email),
    phone: firstNonEmpty(c.phone, c.mobile),
    address: firstNonEmpty(readCanonicalAddressLine(c), c.address1, fullName([c.postalCode, c.city])),
    hasMoneybird: false,
    moneybirdContactId: '',
    _contact: c,
  };
}

export async function searchGhlContacts(query, { locationId, limit = 25 } = {}) {
  if (!GHL_API_KEY || !locationId) return [];
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url =
    `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}` +
    `&query=${encodeURIComponent(q)}&limit=${Math.min(50, Math.max(5, Number(limit) || 25))}`;
  try {
    const res = await fetchWithRetry(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
    });
    if (!res.ok) {
      console.warn('[customer-directory] ghl_search', res.status);
      return [];
    }
    const data = await res.json().catch(() => ({}));
    const rows = Array.isArray(data?.contacts) ? data.contacts : [];
    return rows.map(mapGhlContactCard).filter((r) => r.contactId);
  } catch (err) {
    console.warn('[customer-directory] ghl_search_error', err?.message || err);
    return [];
  }
}

export async function getGhlContact(contactId) {
  const cid = String(contactId || '').trim();
  if (!GHL_API_KEY || !cid) return null;
  try {
    const res = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
      headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data?.contact || data || null;
  } catch (err) {
    console.warn('[customer-directory] ghl_contact_error', err?.message || err);
    return null;
  }
}

// ─── Moneybird ────────────────────────────────────────────────────────────────

function mapMoneybirdCard(c = {}) {
  const personName = fullName([c.firstname, c.lastname]);
  const name = firstNonEmpty(personName, c.company_name) || 'Onbekend';
  return {
    contactId: '',
    source: 'moneybird',
    name,
    email: normalizeEmail(c.email),
    phone: firstNonEmpty(c.phone),
    address: firstNonEmpty(c.address1, fullName([c.zipcode, c.city])),
    hasMoneybird: true,
    moneybirdContactId: toText(c.id),
    _contact: c,
  };
}

export async function searchMoneybirdContacts(query) {
  const { hasMb } = getCustomerDirectoryEnv();
  if (!hasMb) return [];
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  try {
    const rows = await listMoneybirdContacts({ page: 1, perPage: 50, query: q }).catch(() => []);
    return (Array.isArray(rows) ? rows : []).map(mapMoneybirdCard);
  } catch (err) {
    console.warn('[customer-directory] mb_search_error', err?.message || err);
    return [];
  }
}

// ─── Merge GHL + Moneybird ──────────────────────────────────────────────────

export function mergeDirectoryContacts(ghlCards, mbCards) {
  const merged = [];
  const byEmail = new Map();
  const byPhone = new Map();

  for (const card of ghlCards) {
    const emailKey = normalizeEmail(card.email);
    const phoneKey = normalizePhoneKey(card.phone);
    if (emailKey) byEmail.set(emailKey, card);
    if (phoneKey) byPhone.set(phoneKey, card);
    merged.push(card);
  }

  for (const mb of mbCards) {
    const emailKey = normalizeEmail(mb.email);
    const phoneKey = normalizePhoneKey(mb.phone);
    const existing =
      (emailKey && byEmail.get(emailKey)) || (phoneKey && byPhone.get(phoneKey)) || null;
    if (existing) {
      existing.hasMoneybird = true;
      existing.moneybirdContactId = mb.moneybirdContactId;
      if (!existing.phone && mb.phone) existing.phone = mb.phone;
      if (!existing.address && mb.address) existing.address = mb.address;
      continue;
    }
    if (emailKey) byEmail.set(emailKey, mb);
    if (phoneKey) byPhone.set(phoneKey, mb);
    merged.push(mb);
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name, 'nl-NL'));
}

// ─── Supabase snapshots ──────────────────────────────────────────────────────

async function supabaseGet(path) {
  const url0 = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url0 || !key) return [];
  try {
    const res = await fetchWithRetry(`${stripUrl(url0)}/rest/v1/${path}`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Accept-Profile': 'public',
      },
    });
    if (!res.ok) {
      console.warn('[customer-directory] supabase_get', res.status);
      return [];
    }
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[customer-directory] supabase_get_error', err?.message || err);
    return [];
  }
}

/** Eén bulk-query → Map<contactId, { date, type, completed_at }> (laatste per contact). */
export async function fetchLatestSnapshotByContact(contactIds) {
  const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).map((x) => String(x || '').trim()).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const inList = ids.map((id) => `"${id}"`).join(',');
  const rows = await supabaseGet(
    `appointment_snapshots?select=ghl_contact_id,service_date,type,completed_at` +
      `&ghl_contact_id=in.(${encodeURIComponent(inList)})` +
      `&order=service_date.desc,completed_at.desc`
  );
  for (const row of rows) {
    const cid = String(row?.ghl_contact_id || '').trim();
    if (!cid || out.has(cid)) continue;
    out.set(cid, {
      date: ymd(row?.service_date),
      type: toText(row?.type) || null,
      completed_at: toText(row?.completed_at) || null,
    });
  }
  return out;
}

/** Volledige snapshot-historie van één contact, chronologisch oudste eerst. */
export async function fetchSnapshotsForContact(contactId) {
  const cid = String(contactId || '').trim();
  if (!cid) return [];
  const rows = await supabaseGet(
    `appointment_snapshots?select=service_date,route_date,type,status,total_amount,appointment_desc,payload,completed_at` +
      `&ghl_contact_id=eq.${encodeURIComponent(cid)}` +
      `&order=service_date.asc,completed_at.asc`
  );
  return rows.map((row) => {
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
    const lines = Array.isArray(payload?.prijs_regels) ? payload.prijs_regels : [];
    return {
      date: ymd(row?.service_date) || ymd(row?.route_date),
      type: toText(row?.type) || null,
      status: 'klaar',
      totalPrice: toPriceNumber(row?.total_amount),
      priceLines: lines
        .map((l) => ({ desc: toText(l?.desc), price: toPriceNumber(l?.price) ?? 0 }))
        .filter((l) => l.desc),
      source: 'snapshot',
    };
  });
}

// ─── Legacy GHL custom-field "laatste afgeronde afspraak" ───────────────────

/** Leest de overschrijfbare GHL contact-CF's als één legacy afspraak (of null). */
export function readLegacyLastAppointment(contact) {
  if (!contact) return null;
  const date =
    ymd(readContactCustomFieldById(contact, LEGACY_COMPLETE_FIELD_IDS.datum_laatste_onderhoud)) ||
    ymd(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum));
  if (!date) return null;
  const type = toText(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.type_onderhoud)) || null;
  const totalPrice =
    toPriceNumber(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.prijs_totaal)) ??
    toPriceNumber(readContactCustomFieldById(contact, LEGACY_COMPLETE_FIELD_IDS.legacy_prijs));
  const priceLines = parseLegacyPriceLines(contact);
  return { date, type, totalPrice, priceLines };
}

function parseLegacyPriceLines(contact) {
  const rawJson = readContactCustomFieldById(contact, LEGACY_COMPLETE_FIELD_IDS.legacy_prijs_regels);
  if (rawJson) {
    try {
      const arr = JSON.parse(rawJson);
      if (Array.isArray(arr)) {
        return arr
          .map((l) => ({ desc: toText(l?.desc), price: toPriceNumber(l?.price) ?? 0 }))
          .filter((l) => l.desc);
      }
    } catch (_) {}
  }
  const structured = readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.prijs_regels);
  if (structured) {
    return String(structured)
      .split(/\r?\n/)
      .map((line) => {
        const idx = line.lastIndexOf('|');
        if (idx < 0) return null;
        const desc = line.slice(0, idx).trim();
        const price = toPriceNumber(line.slice(idx + 1));
        if (!desc || price == null) return null;
        return { desc, price };
      })
      .filter(Boolean);
  }
  return [];
}

// ─── Redis geplande afspraken ────────────────────────────────────────────────

const TYPE_FROM_WORKTYPE = { installatie: 'installatie', onderhoud: 'onderhoud', reparatie: 'reparatie' };

/** Toekomstige/geplande Model B reserveringen voor een contact. */
export async function getPlannedAppointments(contactId, { todayYmd } = {}) {
  const cid = String(contactId || '').trim();
  if (!cid) return [];
  let reservations = [];
  try {
    reservations = await listReservationsForContact(cid);
  } catch (err) {
    console.warn('[customer-directory] reservations_error', err?.message || err);
    return [];
  }
  const today = isYmd(todayYmd) ? todayYmd : null;
  return (Array.isArray(reservations) ? reservations : [])
    .filter((r) => isYmd(r?.dateStr) && (!today || r.dateStr >= today))
    .map((r) => ({
      date: r.dateStr,
      type: TYPE_FROM_WORKTYPE[String(r?.workType || '').toLowerCase()] || (toText(r?.workType) || null),
      status: 'gepland',
      totalPrice: null,
      priceLines: [],
      source: 'planned',
    }));
}

// ─── Contact-info voor detail ────────────────────────────────────────────────

export function buildContactInfo(contact) {
  if (!contact) return { name: '', email: '', phone: '', address: '', city: '', postalCode: '' };
  const name = firstNonEmpty(fullName([contact.firstName, contact.lastName]), contact.name);
  const city = firstNonEmpty(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.woonplaats), contact.city);
  const postalCode = firstNonEmpty(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.postcode), contact.postalCode);
  return {
    name,
    email: normalizeEmail(contact.email),
    phone: firstNonEmpty(contact.phone, contact.mobile),
    address: firstNonEmpty(readCanonicalAddressLine(contact), contact.address1),
    city,
    postalCode,
  };
}

export { ymd as toYmd };
