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
import { readCanonicalAddressLine, readGhlDuplicateSearchContactId } from './ghl-contact-canonical.js';
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

/**
 * Dedupliceert herhaalde "<postcode> <plaats>"-staarten in een adresregel.
 * Voor reeds vervuilde bestaande contacten (zie address-corruption fix):
 * neemt alleen de eerste postcode-occurrence + bijbehorende plaats.
 */
export function cleanAddress(addr) {
  const s = String(addr || '').replace(/\s+/g, ' ').trim();
  const pc = s.match(/\d{4}\s?[A-Za-z]{2}/);
  if (!pc) return s;
  const idx = s.indexOf(pc[0]);
  const street = s.slice(0, idx).replace(/[,\s]+$/, '').trim();
  const after = s.slice(idx + pc[0].length).replace(/^[,\s]+/, '');
  const city = after.split(/,|\s\d{4}\s?[A-Za-z]{2}/)[0].trim();
  const pcNorm = pc[0].toUpperCase().replace(/(\d{4})\s?([A-Za-z]{2})/, '$1 $2');
  return [street, pcNorm, city].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
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

/**
 * Eén gerichte GHL duplicate-search voor een Moneybird-only kaart.
 * Telefoon eerst (sterkste sleutel), e-mail als fallback (max 2 calls).
 * @returns {Promise<string|null>} GHL contactId of null.
 */
async function lookupGhlContactIdByEmailOrPhone(card, { locationId } = {}) {
  if (!GHL_API_KEY || !locationId) return null;
  const phone = String(card?.phone || '').replace(/\s/g, '');
  const email = normalizeEmail(card?.email);
  const queries = [
    phone ? `number=${encodeURIComponent(phone)}` : '',
    email ? `email=${encodeURIComponent(email)}` : '',
  ].filter(Boolean);
  for (const qs of queries) {
    try {
      const res = await fetchWithRetry(
        `${GHL_BASE}/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&${qs}`,
        { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
      );
      if (!res.ok) continue;
      const cid = readGhlDuplicateSearchContactId(await res.json().catch(() => ({})));
      if (cid) return cid;
    } catch (err) {
      console.warn('[customer-directory] ghl_duplicate_lookup_error', err?.message || err);
    }
  }
  return null;
}

/**
 * Back-resolve: vul voor Moneybird-only matches (geen GHL-hit op de zoekquery)
 * alsnog een GHL `contactId` in via duplicate-search op telefoon/e-mail.
 * Reeds-gemergde kaarten en niet-MB kaarten worden overgeslagen (performance).
 * Muteert en retourneert dezelfde array.
 */
export async function resolveMoneybirdOnlyContactIds(merged, { locationId } = {}) {
  const list = Array.isArray(merged) ? merged : [];
  if (!GHL_API_KEY || !locationId) return list;
  await Promise.all(
    list.map(async (card) => {
      if (!card || card.contactId || card.hasMoneybird !== true) return;
      const cid = await lookupGhlContactIdByEmailOrPhone(card, { locationId });
      if (cid) {
        card.contactId = cid;
        card.source = 'ghl';
      }
    })
  );
  return list;
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
    `appointment_snapshots?select=snapshot_id,service_date,route_date,type,status,total_amount,appointment_desc,payload,completed_at` +
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
      snapshotId: toText(row?.snapshot_id) || null,
      desc: toText(row?.appointment_desc) || toText(payload?.appointment_desc) || '',
      source: 'snapshot',
    };
  });
}

// ─── Legacy GHL custom-field "laatste afgeronde afspraak" ───────────────────

// FIELD_IDS.probleemomschrijving uit api/ghl.js (daar niet als module geëxporteerd).
const GHL_LEGACY_PROBLEEM_CF_ID = 'BBcbPCNA9Eu0Kyi4U1LN';

/** Zelfde leesvolgorde als de planner (planner-appointments-source.js): canon → legacy fallback. */
function readProblemDescription(contact) {
  return (
    toText(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.probleemomschrijving)) ||
    toText(readContactCustomFieldById(contact, GHL_LEGACY_PROBLEEM_CF_ID))
  );
}

/**
 * Leest de overschrijfbare GHL contact-CF's als één legacy afspraak (of null).
 *
 * BELANGRIJK (P1-fix): datum komt UITSLUITEND uit `datum_laatste_onderhoud`
 * (gezet bij completion/"Klaar"). De oude fallback op `boeking_bevestigd_datum`
 * is geschrapt: dat veld wordt bij élke nieuwe booking overschreven, waardoor een
 * toekomstige geplande afspraak ten onrechte als afgeronde "legacy" verscheen.
 */
export function readLegacyLastAppointment(contact) {
  if (!contact) return null;
  const date = ymd(readContactCustomFieldById(contact, LEGACY_COMPLETE_FIELD_IDS.datum_laatste_onderhoud));
  if (!date) return null;
  const type = toText(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.type_onderhoud)) || null;
  const totalPrice =
    toPriceNumber(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.prijs_totaal)) ??
    toPriceNumber(readContactCustomFieldById(contact, LEGACY_COMPLETE_FIELD_IDS.legacy_prijs));
  const priceLines = parseLegacyPriceLines(contact);
  const desc = readProblemDescription(contact);
  return { date, type, totalPrice, priceLines, desc };
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

/**
 * Booking-CF's van een contact als "voorlopige" verrijking voor de meest recente
 * geplande afspraak (probleemomschrijving + prijs). Per-contact, dus alléén te
 * koppelen aan de meest recente planned-rij (zie customer-detail).
 */
export function readPlannedEnrichment(contact) {
  if (!contact) return { desc: '', totalPrice: null, priceLines: [] };
  const desc = readProblemDescription(contact);
  const totalPrice =
    toPriceNumber(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.prijs_totaal)) ??
    toPriceNumber(readContactCustomFieldById(contact, LEGACY_COMPLETE_FIELD_IDS.legacy_prijs));
  const priceLines = parseLegacyPriceLines(contact);
  return { desc, totalPrice, priceLines };
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
    address: cleanAddress(firstNonEmpty(readCanonicalAddressLine(contact), contact.address1)),
    city,
    postalCode,
  };
}

export { ymd as toYmd };
