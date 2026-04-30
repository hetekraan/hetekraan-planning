import { Redis } from '@upstash/redis';
import { verifySessionToken } from '../lib/session.js';
import { fetchWithRetry } from '../lib/retry.js';
import { ghlCalendarIdFromEnv, ghlLocationIdFromEnv, GHL_CONFIG_MISSING_MSG } from '../lib/ghl-env-ids.js';
import {
  fetchBlockedSlotsAsEvents,
  markBlockLikeOnCalendarEvents,
  resolveBlockSlotAssignedUserId,
} from '../lib/ghl-calendar-blocks.js';
import { mapEnrichedGhlEventToAppointment } from '../lib/planning/appointment.js';
import { eventStartMsGhl, canonicalGhlEventId } from '../lib/planning/ghl-event-core.js';
import { parseStructuredPriceRulesString } from '../lib/booking-canon-fields.js';
import { readCanonicalAddressLine, splitAddressLineToStraatHuis } from '../lib/ghl-contact-canonical.js';
import { resolveContactCustomFieldId } from '../lib/ghl-custom-fields.js';
import { addAmsterdamCalendarDays, formatYyyyMmDdInAmsterdam, amsterdamCalendarDayBoundsMs } from '../lib/amsterdam-calendar-day.js';
import { cachedListConfirmedSyntheticEventsForDate } from '../lib/amsterdam-day-read-cache.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const RESULT_CACHE_TTL_SEC = 30 * 60;
const CONTACT_CACHE_TTL_SEC = 24 * 60 * 60;

const FIELD_IDS = {
  tijdafspraak: 'UAE5RYGQAfY8k5w5Yaon',
  type_onderhoud: 'M7r1T0AjWln7W8L4hNfW',
  probleemomschrijving: 'R7vU3nS4M6j9K2pQ8xYt',
  prijs: 'GTM68UTLsdrWHrxOvcxR',
  prijs_regels: 'mNf4R2tY8wQ6eL1kP9dS',
  opmerkingen: 'xYv2L8sQ4rN1pT7mW5cH',
};

const BOOKING_FORM_FIELD_IDS = {
  straat_huisnummer: 'n4vS2xQ9mW6tL1rP8dYk',
  postcode: 'c8dY1pL4tQ7mS2rN5xWv',
  woonplaats: 'w6pN3rT9mQ2xL8dY1sVh',
  type_onderhoud: 'd9mQ2xL8pR5tN1vS4yWk',
  probleemomschrijving: 'p2xL8dY1mQ4rT7nS5vWk',
  prijs_totaal: 'v7nS5xL2dY8mQ1rT4pWk',
  prijs_regels: 'k5rT1mQ8xL2dY4nS7vWp',
  tijdslot: 'g8mQ2xL5dY1rT4nS7vWp',
  betaal_status: 'j4rT8mQ2xL1dY5nS7vWp',
};

let _redis = undefined;
let _plannerNotitiesFieldId = null;
let _plannerInternalFixedStartFieldId = null;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) _redis = new Redis({ url, token });
  return _redis;
}

function redisPrefix() {
  return String(process.env.REDIS_KEY_PREFIX || 'prod:');
}

function contactCacheKey(contactId) {
  return `${redisPrefix()}hk:analytics:contact:${String(contactId || '').trim()}`;
}

function resultCacheKey(periodKey) {
  return `${redisPrefix()}analytics:${String(periodKey || '').trim()}`;
}

function ensureAuth(req) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

function periodToDays(period) {
  const p = String(period || '').trim().toLowerCase();
  if (p === 'vandaag' || p === 'today') return { key: 'today', days: 1 };
  if (p === '7d') return { key: '7d', days: 7 };
  if (p === 'kwartaal') return { key: 'kwartaal', days: 90 };
  if (p === 'jaar') return { key: 'jaar', days: 365 };
  return { key: '30d', days: 30 };
}

function isValidYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
}

function buildRangeFromRequest(query = {}) {
  const startDateRaw = String(query?.startDate || '').trim();
  const endDateRaw = String(query?.endDate || '').trim();
  if (isValidYmd(startDateRaw) && isValidYmd(endDateRaw) && startDateRaw <= endDateRaw) {
    const startBounds = amsterdamCalendarDayBoundsMs(startDateRaw);
    const endBounds = amsterdamCalendarDayBoundsMs(endDateRaw);
    return {
      mode: 'custom',
      key: `custom:${startDateRaw}:${endDateRaw}`,
      period: 'custom',
      startDate: startDateRaw,
      endDate: endDateRaw,
      startMs: startBounds?.startMs,
      endMs: endBounds?.endMs,
    };
  }
  const { key, days } = periodToDays(query?.period);
  const periodRange = dateRangeFromPeriod(key, days);
  return {
    mode: 'period',
    key,
    period: key,
    startDate: periodRange.startDate,
    endDate: periodRange.endDate,
    startMs: periodRange.startMs,
    endMs: periodRange.endMs,
  };
}

function getField(contact, fieldId, fieldKey = '') {
  const fid = String(fieldId || '').trim();
  if (!contact?.customFields || !Array.isArray(contact.customFields)) return '';
  const match = contact.customFields.find((f) => {
    const idOk = fid && String(f?.id ?? f?.fieldId ?? f?.customFieldId ?? '').trim() === fid;
    const keyOk = fieldKey && String(f?.key ?? f?.fieldKey ?? '').trim() === String(fieldKey).trim();
    return idOk || keyOk;
  });
  if (!match) return '';
  const raw = match.value ?? match.field_value;
  return raw == null ? '' : String(raw).trim();
}

async function resolvePlannerNotitiesFieldId() {
  if (_plannerNotitiesFieldId) return _plannerNotitiesFieldId;
  _plannerNotitiesFieldId = await resolveContactCustomFieldId({
    baseUrl: GHL_BASE,
    apiKey: GHL_API_KEY,
    locationId: ghlLocationIdFromEnv(),
    fieldKey: 'planner_notities',
    objectType: 'contact',
    envOverride: String(process.env.GHL_FIELD_ID_PLANNER_NOTITIES || '').trim(),
  });
  return _plannerNotitiesFieldId;
}

async function resolvePlannerInternalFixedStartFieldId() {
  if (_plannerInternalFixedStartFieldId) return _plannerInternalFixedStartFieldId;
  _plannerInternalFixedStartFieldId = await resolveContactCustomFieldId({
    baseUrl: GHL_BASE,
    apiKey: GHL_API_KEY,
    locationId: ghlLocationIdFromEnv(),
    fieldKey: 'planner_internal_fixed_start',
    objectType: 'contact',
    envOverride: String(process.env.GHL_FIELD_ID_PLANNER_INTERNAL_FIXED_START || '').trim(),
  });
  return _plannerInternalFixedStartFieldId;
}

function normalizeInternalFixedPinFromBody(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    const type = String(parsed.type || '').trim().toLowerCase();
    const time = String(parsed.time || '').trim();
    if (!['exact', 'after', 'before'].includes(type)) return null;
    if (!/^\d{2}:\d{2}$/.test(time)) return null;
    return { type, time };
  } catch {
    return null;
  }
}

function dateRangeFromPeriod(periodKey, days) {
  const today = formatYyyyMmDdInAmsterdam(new Date());
  const startDate = addAmsterdamCalendarDays(today, -(days - 1));
  const endDate = today;
  const startBounds = amsterdamCalendarDayBoundsMs(startDate);
  const endBounds = amsterdamCalendarDayBoundsMs(endDate);
  return {
    period: periodKey,
    startDate,
    endDate,
    startMs: startBounds?.startMs,
    endMs: endBounds?.endMs,
  };
}

async function fetchCalendarEventsRange({ locationId, calendarId, startMs, endMs, apiKey }) {
  let calls = 0;
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${startMs}&endTime=${endMs}&page=${page}&limit=100`;
    calls += 1;
    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
    });
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`GHL calendars/events fout (${response.status}): ${txt.slice(0, 180)}`);
    }
    const data = await response.json().catch(() => ({}));
    const rows = Array.isArray(data?.events) ? data.events : [];
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return { events: out, calls };
}

async function readCachedContact(contactId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(contactCacheKey(contactId));
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function writeCachedContact(contactId, contact) {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(contactCacheKey(contactId), JSON.stringify(contact), { ex: CONTACT_CACHE_TTL_SEC });
}

async function fetchContactById(contactId) {
  const cached = await readCachedContact(contactId);
  if (cached) return { contact: cached, fromCache: true, calls: 0 };
  let calls = 0;
  calls += 1;
  const cr = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
  });
  if (!cr.ok) return { contact: null, fromCache: false, calls };
  const cd = await cr.json().catch(() => ({}));
  const contact = cd?.contact || cd || null;
  if (contact) await writeCachedContact(contactId, contact);
  return { contact, fromCache: false, calls };
}

function eventYmdFromStartMs(ev) {
  const ms = eventStartMsGhl(ev);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) return '';
  return formatYyyyMmDdInAmsterdam(new Date(ms)) || '';
}

function calcTotalPrice(a) {
  const base = Number(a?.price) || 0;
  const extra = Array.isArray(a?.extras) ? a.extras.reduce((s, x) => s + (Number(x?.price) || 0), 0) : 0;
  return Math.round((base + extra) * 100) / 100;
}

function paymentIsPaid(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;
  return t.includes('betaald') || t.includes('paid') || t.includes('afgerond');
}

function buildAnalyticsFromAppointments(appointments = []) {
  const clients = appointments.filter((a) => !a.isCalBlock && !a.isSyntheticBlockBooking);
  const totaalAfspraken = clients.length;
  const totaleOmzet = Math.round(clients.reduce((s, a) => s + calcTotalPrice(a), 0) * 100) / 100;
  const gemiddeldeWaarde = totaalAfspraken ? Math.round((totaleOmzet / totaalAfspraken) * 100) / 100 : 0;
  const openstaandTeFactureren = Math.round(
    clients.reduce((s, a) => (paymentIsPaid(a.paymentStatus) ? s : s + calcTotalPrice(a)), 0) * 100
  ) / 100;
  const byType = {};
  for (const a of clients) {
    const t = String(a.jobType || 'onbekend').toLowerCase();
    if (!byType[t]) byType[t] = { jobType: t, aantal: 0, omzet: 0 };
    byType[t].aantal += 1;
    byType[t].omzet = Math.round((byType[t].omzet + calcTotalPrice(a)) * 100) / 100;
  }
  const weekMap = {};
  const recentAppointments = [...clients]
    .sort((a, b) => Number(b.startMs || 0) - Number(a.startMs || 0))
    .slice(0, 10)
    .map((a) => ({
      id: a.id,
      datum: eventYmdFromStartMs({ startTime: a.startMs }) || '',
      klant: a.name || '',
      adres: a.fullAddressLine || a.address || '',
      werksoort: a.jobType || 'onbekend',
      bedrag: calcTotalPrice(a),
      status: a.status || '',
      contactId: a.contactId || '',
    }));
  const categoryCostFactor = { installatie: 0.58, reparatie: 0.62, onderhoud: 0.55, onbekend: 0.6 };
  for (const a of clients) {
    const date = eventYmdFromStartMs({ startTime: a.startMs });
    if (!date) continue;
    const d = new Date(`${date}T12:00:00Z`);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    const wk = `${d.getUTCFullYear()}-W${String(Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)).padStart(2, '0')}`;
    const jobType = String(a.jobType || 'onbekend').toLowerCase();
    if (!weekMap[wk]) weekMap[wk] = { week: wk, omzet: 0, marge: 0, installatie: 0, reparatie: 0, onderhoud: 0 };
    const total = calcTotalPrice(a);
    const factor = Number(categoryCostFactor[jobType] ?? categoryCostFactor.onbekend);
    const margin = Math.max(0, total - total * factor);
    weekMap[wk].omzet = Math.round((weekMap[wk].omzet + total) * 100) / 100;
    weekMap[wk].marge = Math.round((weekMap[wk].marge + margin) * 100) / 100;
    if (jobType === 'installatie' || jobType === 'reparatie' || jobType === 'onderhoud') {
      weekMap[wk][jobType] = Math.round((Number(weekMap[wk][jobType]) + total) * 100) / 100;
    }
  }
  const omzetByWeek = Object.values(weekMap).sort((a, b) => String(a.week).localeCompare(String(b.week)));
  const uniqueByContact = new Set(clients.map((a) => String(a.contactId || '').trim()).filter(Boolean));
  const repeatByContact = new Map();
  clients.forEach((a) => {
    const cid = String(a.contactId || '').trim();
    if (!cid) return;
    repeatByContact.set(cid, (repeatByContact.get(cid) || 0) + 1);
  });
  const repeaters = [...repeatByContact.values()].filter((n) => n > 1).length;
  const repeatPct = uniqueByContact.size ? Math.round((repeaters / uniqueByContact.size) * 1000) / 10 : 0;

  return {
    kpis: {
      totaalAfspraken,
      totaleOmzet,
      gemiddeldeWaarde,
      openstaandTeFactureren,
    },
    jobTypeVerdeling: Object.values(byType).sort((a, b) => b.omzet - a.omzet),
    omzetByWeek,
    recentAppointments,
    repeatCustomersPct: repeatPct,
  };
}

async function readResultCache(periodKey) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(resultCacheKey(periodKey));
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function writeResultCache(periodKey, payload) {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(resultCacheKey(periodKey), JSON.stringify(payload), { ex: RESULT_CACHE_TTL_SEC });
}

async function runAnalytics(rangeInput) {
  const locId = ghlLocationIdFromEnv();
  const calId = ghlCalendarIdFromEnv();
  const range = rangeInput;
  const plannerNotitiesFieldId = await resolvePlannerNotitiesFieldId();
  const plannerInternalFixedStartFieldId = await resolvePlannerInternalFixedStartFieldId();

  let ghlCalls = 0;
  let usedContactCache = false;
  const calRes = await fetchCalendarEventsRange({
    locationId: locId,
    calendarId: calId,
    startMs: range.startMs,
    endMs: range.endMs,
    apiKey: GHL_API_KEY,
  });
  ghlCalls += Number(calRes.calls || 0);
  const events = Array.isArray(calRes.events) ? calRes.events : [];
  markBlockLikeOnCalendarEvents(events);

  // Helper gebruikt intern meerdere GHL-calls; we tellen deze als 1 logical blocked-slots fetch.
  ghlCalls += 1;
  const blockSlotUserId = await resolveBlockSlotAssignedUserId(GHL_BASE, GHL_API_KEY, locId, calId);
  const blockedAsEvents = await fetchBlockedSlotsAsEvents(GHL_BASE, {
    locationId: locId,
    calendarId: calId,
    startMs: range.startMs,
    endMs: range.endMs,
    apiKey: GHL_API_KEY,
    assignedUserId: blockSlotUserId,
  });
  if (blockedAsEvents.length) events.push(...blockedAsEvents);

  // Keep synthetic block reservations in dataset, then filter them out in KPI step.
  for (let d = range.startDate; d && d <= range.endDate; d = addAmsterdamCalendarDays(d, 1)) {
    const synthetic = await cachedListConfirmedSyntheticEventsForDate(d).catch(() => []);
    for (const ev of synthetic) {
      const cid = String(ev.contactId || ev.contact_id || '').trim();
      if (!cid) continue;
      events.push({ ...ev, id: `hk-b1:${cid}:${d}`, _hkBlockReservationSynthetic: true });
    }
  }

  const uniqueCids = [
    ...new Set(
      events
        .map((e) => String(e.contactId || e.contact_id || '').trim())
        .filter(Boolean)
    ),
  ];

  const contactMap = {};
  await Promise.all(
    uniqueCids.map(async (cid) => {
      const out = await fetchContactById(cid).catch(() => ({ contact: null, fromCache: false, calls: 0 }));
      ghlCalls += Number(out.calls || 0);
      if (out.fromCache) usedContactCache = true;
      if (out.contact) contactMap[cid] = out.contact;
    })
  );

  for (const e of events) {
    const cid = String(e.contactId || e.contact_id || '').trim();
    if (!cid || !contactMap[cid]) continue;
    const contact = contactMap[cid];
    e.contact = contact;
    e.contactId = contact.id || cid;
    const canonStreetHouse = getField(contact, BOOKING_FORM_FIELD_IDS.straat_huisnummer);
    const canonPostcode = getField(contact, BOOKING_FORM_FIELD_IDS.postcode);
    const canonWoonplaats = getField(contact, BOOKING_FORM_FIELD_IDS.woonplaats);
    const splitCanon = splitAddressLineToStraatHuis(canonStreetHouse);
    const straat = splitCanon.straatnaam || '';
    const huisnr = splitCanon.huisnummer || '';
    const postcode = canonPostcode || String(contact.postalCode || '').replace(/\s+/g, ' ').trim();
    const woonplaats = canonWoonplaats || contact.city || '';
    const canonical = readCanonicalAddressLine(contact);
    if (straat || huisnr || postcode || woonplaats) {
      e.parsedStraatnaam = straat;
      e.parsedHuisnummer = huisnr;
      e.parsedPostcode = postcode;
      e.parsedWoonplaats = woonplaats;
    } else if (canonical) {
      e.parsedStraatnaam = canonical;
      e.parsedHuisnummer = '';
      e.parsedPostcode = '';
      e.parsedWoonplaats = '';
    }
    const canonWerkzaamheden = getField(contact, BOOKING_FORM_FIELD_IDS.probleemomschrijving);
    e.parsedJobType = getField(contact, BOOKING_FORM_FIELD_IDS.type_onderhoud) || '';
    e.parsedWork = canonWerkzaamheden || getField(contact, FIELD_IDS.probleemomschrijving) || e.title;
    e.parsedPrice = getField(contact, BOOKING_FORM_FIELD_IDS.prijs_totaal) || getField(contact, FIELD_IDS.prijs);
    e.parsedNotes = (plannerNotitiesFieldId ? getField(contact, plannerNotitiesFieldId) : '') || getField(contact, FIELD_IDS.opmerkingen);
    e.parsedTimeWindow = getField(contact, BOOKING_FORM_FIELD_IDS.tijdslot) || getField(contact, FIELD_IDS.tijdafspraak) || null;
    e.parsedPaymentStatus = getField(contact, BOOKING_FORM_FIELD_IDS.betaal_status) || '';
    const rawInternalFixed = plannerInternalFixedStartFieldId
      ? getField(contact, plannerInternalFixedStartFieldId, 'planner_internal_fixed_start')
      : '';
    const parsedInternalFixed = normalizeInternalFixedPinFromBody(rawInternalFixed);
    e.internalFixedPin = parsedInternalFixed;
    e.internalFixedStartTime = parsedInternalFixed?.time || '';
    const canonPrijsRegels = getField(contact, BOOKING_FORM_FIELD_IDS.prijs_regels);
    let parsedPrijsRegels = parseStructuredPriceRulesString(canonPrijsRegels);
    if (!parsedPrijsRegels.length) parsedPrijsRegels = parseStructuredPriceRulesString(getField(contact, FIELD_IDS.prijs_regels));
    e.parsedExtras = parsedPrijsRegels;
  }

  const deduped = [];
  const seen = new Set();
  for (const ev of events) {
    const id = canonicalGhlEventId(ev) || String(ev.id || '');
    const key = id || `${eventStartMsGhl(ev)}:${String(ev.contactId || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ev);
  }

  const appointments = deduped.map((ev, i) => {
    const ymd = eventYmdFromStartMs(ev) || range.endDate;
    return mapEnrichedGhlEventToAppointment(ev, i, ymd);
  });

  const analytics = buildAnalyticsFromAppointments(appointments);
  return {
    period: range.period,
    startDate: range.startDate,
    endDate: range.endDate,
    ...analytics,
    meta: {
      ghlCalls,
      uniqueContacts: uniqueCids.length,
      cacheHit: usedContactCache ? 'contacts' : 'none',
      period: range.period,
      generatedAt: new Date().toISOString(),
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ensureAuth(req)) return res.status(401).json({ error: 'Niet geautoriseerd' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const locConfigured = ghlLocationIdFromEnv();
  const calConfigured = ghlCalendarIdFromEnv();
  if (!GHL_API_KEY || !locConfigured || !calConfigured) {
    return res.status(503).json({ error: GHL_CONFIG_MISSING_MSG });
  }

  const range = buildRangeFromRequest(req.query || {});
  const cacheHit = await readResultCache(range.key);
  if (cacheHit?.period && cacheHit?.kpis) {
    return res.status(200).json({
      ok: true,
      source: 'cache',
      ...cacheHit,
      meta: {
        ...(cacheHit.meta || {}),
        cacheHit: 'result',
        period: range.period,
      },
    });
  }

  try {
    const payload = await runAnalytics(range);
    await writeResultCache(range.key, payload);
    return res.status(200).json({ ok: true, source: 'live', ...payload });
  } catch (err) {
    const fallback = await readResultCache(range.key);
    if (fallback?.period && fallback?.kpis) {
      return res.status(200).json({
        ok: true,
        source: 'cache_fallback',
        warning: String(err?.message || err),
        ...fallback,
        meta: {
          ...(fallback.meta || {}),
          cacheHit: 'result',
          period: range.period,
        },
      });
    }
    return res.status(502).json({
      ok: false,
      error: 'Analytics ophalen mislukt',
      detail: String(err?.message || err),
    });
  }
}
