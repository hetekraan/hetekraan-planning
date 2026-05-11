/**
 * Laadt analytics-relevante data uit Supabase (PostgREST) voor /api/analytics.
 * Geen writes. Alleen GET.
 */

import { fetchWithRetry } from './retry.js';
import { inferDashboardJobTypeFromWorkText } from './planning/appointment.js';
import { amsterdamCalendarDayBoundsMs } from './amsterdam-calendar-day.js';
import { parseStructuredPriceRulesString, toPriceNumber } from './booking-canon-fields.js';

const PAGE = 500;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_FIELD_IDS = {
  prijs: 'GTM68UTLsdrWHrxOvcxR',
  prijs_regels: 'mNf4R2tY8wQ6eL1kP9dS',
};
const BOOKING_FORM_FIELD_IDS = {
  prijs_totaal: 'v7nS5xL2dY8mQ1rT4pWk',
  prijs_regels: 'k5rT1mQ8xL2dY4nS7vWp',
};

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

function isCancelledStatus(status) {
  return String(status ?? '').trim().toLowerCase() === 'cancelled';
}

function looksSyntheticAppointment(row) {
  const src = String(row?.source ?? '').toLowerCase();
  if (src.includes('redis') || src.includes('b1')) return true;
  const ext = String(row?.external_booking_id ?? '');
  if (/^hk-b1:/i.test(ext)) return true;
  const rp = row?.raw_payload;
  if (rp && typeof rp === 'object' && (rp.redisReservationId || rp.backfillSource === 'backfill-redis')) return true;
  return false;
}

function paymentFromRow(row) {
  const rp = row?.raw_payload;
  if (!rp || typeof rp !== 'object') return '';
  return String(rp.parsedPaymentStatus || rp.paymentStatus || rp.betaal_status || '').trim();
}

function workTextFromRow(row) {
  const d = String(row?.problem_description ?? '').trim();
  if (d) return d;
  const rp = row?.raw_payload;
  if (rp && typeof rp === 'object') {
    const w = String(rp.parsedWork || rp.work || '').trim();
    if (w) return w;
  }
  return '';
}

function jobTypeFromRow(row) {
  const rp = row?.raw_payload;
  if (rp && typeof rp === 'object') {
    const j = String(rp.parsedJobType || rp.jobType || '').trim().toLowerCase();
    if (j && j !== 'onbekend') return j;
  }
  return inferDashboardJobTypeFromWorkText(workTextFromRow(row));
}

function toMoneyNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = toPriceNumber(raw);
  return parsed === null ? null : Math.round(parsed * 100) / 100;
}

function collectRawPayloadObjects(row) {
  const out = [];
  const rp = row?.raw_payload;
  if (rp && typeof rp === 'object') out.push(rp);
  if (rp && typeof rp === 'object' && rp.response && typeof rp.response === 'object') out.push(rp.response);
  return out;
}

function totalAmountFromRawPayload(row) {
  for (const obj of collectRawPayloadObjects(row)) {
    for (const key of ['parsedPrice', 'price', 'priceTotal', 'totalPrice', 'prijs', 'prijs_totaal']) {
      const n = toMoneyNumber(obj?.[key]);
      if (n !== null && n >= 0) return n;
    }
  }
  return null;
}

function priceLinesFromRawPayload(row) {
  const out = [];
  for (const obj of collectRawPayloadObjects(row)) {
    const arrays = [];
    if (Array.isArray(obj?.priceLines)) arrays.push(obj.priceLines);
    if (Array.isArray(obj?.parsedExtras)) arrays.push(obj.parsedExtras);
    if (Array.isArray(obj?.extras)) arrays.push(obj.extras);
    for (const arr of arrays) {
      for (const ln of arr) {
        if (!ln || typeof ln !== 'object') continue;
        const desc = String(ln.desc ?? ln.description ?? ln.label ?? '').trim();
        const price = toMoneyNumber(ln.total_price ?? ln.totalPrice ?? ln.price ?? ln.amount ?? ln.value);
        if (!desc || price === null || !Number.isFinite(price)) continue;
        out.push({ desc, price });
      }
    }
    for (const key of ['serializedPrijsRegels', 'prijsRegels', 'prijs_regels']) {
      const parsed = parseStructuredPriceRulesString(String(obj?.[key] ?? ''));
      if (parsed.length) out.push(...parsed);
    }
  }
  return out;
}

function readContactCustomFieldById(contact, fieldId) {
  const fid = String(fieldId || '').trim();
  if (!fid || !contact?.customFields || !Array.isArray(contact.customFields)) return '';
  const match = contact.customFields.find(
    (f) => String(f?.id ?? f?.fieldId ?? f?.customFieldId ?? '').trim() === fid
  );
  if (!match) return '';
  return String(match?.value ?? match?.field_value ?? '').trim();
}

function buildPriceFallbackFromGhlContact(contact) {
  if (!contact || typeof contact !== 'object') return { totalAmount: null, priceLines: [] };
  const totalAmount =
    toMoneyNumber(readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.prijs_totaal)) ??
    toMoneyNumber(readContactCustomFieldById(contact, GHL_FIELD_IDS.prijs));
  const fromCanon = parseStructuredPriceRulesString(
    readContactCustomFieldById(contact, BOOKING_FORM_FIELD_IDS.prijs_regels)
  );
  const fromLegacy = parseStructuredPriceRulesString(
    readContactCustomFieldById(contact, GHL_FIELD_IDS.prijs_regels)
  );
  return {
    totalAmount,
    priceLines: fromCanon.length ? fromCanon : fromLegacy,
  };
}

async function fetchGhlContactPriceFallback(ghlContactId) {
  const cid = String(ghlContactId || '').trim();
  const apiKey = String(process.env.GHL_API_KEY || '').trim();
  if (!cid || !apiKey) return { totalAmount: null, priceLines: [] };
  const res = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
  });
  if (!res.ok) return { totalAmount: null, priceLines: [] };
  const data = await res.json().catch(() => ({}));
  const contact = data?.contact || data || null;
  return buildPriceFallbackFromGhlContact(contact);
}

/**
 * Zelfde logica als mapEnrichedGhlEventToAppointment voor extras vs totaal:
 * basis = totaal − som(regels) als totaal ≥ som(regels), anders 0 + regels.
 */
function priceAndExtrasFromLines(totalAmountRaw, lines, row, fallback = null) {
  const extras = (Array.isArray(lines) ? lines : []).map((ln) => {
    const desc = String(ln?.description ?? ln?.desc ?? ln?.label ?? '').trim();
    const q = Number(ln?.quantity) || 1;
    const unit = toMoneyNumber(ln?.unit_price);
    const tot = toMoneyNumber(ln?.total_price);
    let price = Number.isFinite(tot) ? tot : null;
    if (price == null && Number.isFinite(unit)) price = Math.round(unit * q * 100) / 100;
    if (price == null) {
      const rp = ln?.raw_payload && typeof ln.raw_payload === 'object' ? ln.raw_payload : null;
      price = toMoneyNumber(rp?.price ?? rp?.amount ?? rp?.value);
    }
    if (price == null || !Number.isFinite(price)) price = 0;
    return { desc, price };
  });
  const fallbackLines = extras.length ? [] : [...priceLinesFromRawPayload(row), ...(fallback?.priceLines || [])];
  const allExtras = [...extras, ...fallbackLines];
  const extrasSum = allExtras.reduce((s, x) => s + (Number(x.price) || 0), 0);
  const totalCanon = toMoneyNumber(totalAmountRaw);
  const totalFromPayload = totalAmountFromRawPayload(row);
  const totalFromFallback = toMoneyNumber(fallback?.totalAmount);
  const effectiveTotal = totalCanon ?? totalFromPayload ?? totalFromFallback;
  let price = 0;
  if (allExtras.length === 0) {
    price = Number.isFinite(effectiveTotal) ? effectiveTotal : 0;
  } else if (Number.isFinite(effectiveTotal)) {
    price = Math.round((effectiveTotal - extrasSum) * 100) / 100;
  } else {
    price = 0;
  }
  return { price, extras: allExtras };
}

function resolveCustomerForAppointment(row, byId, byGhl) {
  const cid = row?.customer_id;
  if (cid && byId.has(String(cid))) return byId.get(String(cid));
  const ghl = String(row?.ghl_contact_id ?? '').trim();
  if (ghl && byGhl.has(ghl)) return byGhl.get(ghl);
  return null;
}

function customerDisplayName(c) {
  if (!c) return '';
  return String(c.name || '').trim();
}

async function restGetJson(url, key) {
  const res = await fetchWithRetry(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Accept-Profile': 'public',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Supabase REST (${res.status}): ${txt.slice(0, 220)}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => []);
}

async function fetchAllRows(base, key, pathWithQuery) {
  const out = [];
  let offset = 0;
  for (;;) {
    const url = `${base}${pathWithQuery}${pathWithQuery.includes('?') ? '&' : '?'}limit=${PAGE}&offset=${offset}`;
    const chunk = await restGetJson(url, key);
    const rows = Array.isArray(chunk) ? chunk : [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} supabaseUrl
 * @param {string} serviceKey
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 */
export async function loadSupabaseAnalyticsAppointments(supabaseUrl, serviceKey, startDate, endDate) {
  const base = `${stripUrl(supabaseUrl)}/rest/v1`;
  const sel = encodeURIComponent(
    'id,service_date,day_part,status,total_amount,ghl_contact_id,customer_id,address,problem_description,raw_payload,external_booking_id,source'
  );
  const path = `/appointments?select=${sel}&service_date=gte.${startDate}&service_date=lte.${endDate}&order=service_date.asc,id.asc`;
  const apptsRaw = await fetchAllRows(base, serviceKey, path);
  const appts = apptsRaw.filter((r) => !isCancelledStatus(r.status));

  const customerIds = [...new Set(appts.map((a) => a.customer_id).filter(Boolean).map(String))];
  const ghlIds = [...new Set(appts.map((a) => a.ghl_contact_id).filter(Boolean).map(String))];

  const byId = new Map();
  for (const ch of chunkArray(customerIds, 80)) {
    const inList = ch.map(encodeURIComponent).join(',');
    const rows = await fetchAllRows(
      base,
      serviceKey,
      `/customers?select=id,name,ghl_contact_id,address&id=in.(${inList})`
    );
    for (const c of rows) {
      if (c?.id) byId.set(String(c.id), c);
    }
  }

  const byGhl = new Map();
  for (const ch of chunkArray(ghlIds, 80)) {
    const inList = ch.map(encodeURIComponent).join(',');
    const rows = await fetchAllRows(
      base,
      serviceKey,
      `/customers?select=id,name,ghl_contact_id,address&ghl_contact_id=in.(${inList})`
    );
    for (const c of rows) {
      const g = String(c?.ghl_contact_id ?? '').trim();
      if (g) byGhl.set(g, c);
    }
  }

  const apptUuidIds = appts.map((a) => a.id).filter(Boolean).map(String);
  const linesByAppt = new Map();
  for (const ch of chunkArray(apptUuidIds, 80)) {
    const inList = ch.map(encodeURIComponent).join(',');
    const lines = await fetchAllRows(
      base,
      serviceKey,
      `/appointment_price_lines?select=appointment_id,line_index,description,quantity,unit_price,total_price&appointment_id=in.(${inList})&order=appointment_id.asc,line_index.asc`
    );
    for (const ln of lines) {
      const aid = String(ln?.appointment_id ?? '').trim();
      if (!aid) continue;
      if (!linesByAppt.has(aid)) linesByAppt.set(aid, []);
      linesByAppt.get(aid).push(ln);
    }
  }

  /** Zelfde vorm als mapEnrichedGhlEventToAppointment output voor buildAnalyticsFromAppointments */
  const mapped = [];
  const ghlPriceFallbackByContact = new Map();
  for (const row of appts) {
    const serviceDate = String(row.service_date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) continue;
    const bounds = amsterdamCalendarDayBoundsMs(serviceDate);
    const startMs = bounds?.startMs ?? Date.parse(`${serviceDate}T12:00:00Z`);
    const cust = resolveCustomerForAppointment(row, byId, byGhl);
    const lines = linesByAppt.get(String(row.id)) || [];
    const ghlContactId = String(row.ghl_contact_id ?? '').trim();
    if (ghlContactId && !ghlPriceFallbackByContact.has(ghlContactId)) {
      const fallback = await fetchGhlContactPriceFallback(ghlContactId).catch(() => ({
        totalAmount: null,
        priceLines: [],
      }));
      ghlPriceFallbackByContact.set(ghlContactId, fallback);
    }
    const { price, extras } = priceAndExtrasFromLines(
      row.total_amount,
      lines,
      row,
      ghlPriceFallbackByContact.get(ghlContactId) || null
    );
    const addr =
      String(row.address ?? '').trim() ||
      String(cust?.address ?? '').trim() ||
      '';
    const extId = String(row.external_booking_id ?? row.id ?? '').trim();
    mapped.push({
      id: extId || String(row.id),
      isCalBlock: false,
      isSyntheticBlockBooking: looksSyntheticAppointment(row),
      contactId: String(row.ghl_contact_id ?? '').trim(),
      startMs,
      name: customerDisplayName(cust),
      fullAddressLine: addr,
      address: addr,
      jobType: jobTypeFromRow(row),
      price,
      extras,
      paymentStatus: paymentFromRow(row),
      status: String(row.status ?? '').trim() || 'ingepland',
    });
  }

  return {
    appointments: mapped,
    meta: {
      supabaseAppointmentRows: appts.length,
      supabaseCustomerIdChunks: Math.ceil(customerIds.length / 80) || 0,
      supabaseGhlContactChunks: Math.ceil(ghlIds.length / 80) || 0,
      supabasePriceLineChunks: Math.ceil(apptUuidIds.length / 80) || 0,
    },
  };
}
