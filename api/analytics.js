import { Redis } from '@upstash/redis';
import { verifySessionToken } from '../lib/session.js';
import { ghlCalendarIdFromEnv, ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import {
  fetchBlockedSlotsAsEvents,
  markBlockLikeOnCalendarEvents,
  resolveBlockSlotAssignedUserId,
} from '../lib/ghl-calendar-blocks.js';
import { mapEnrichedGhlEventToAppointment } from '../lib/planning/appointment.js';
import { eventStartMsGhl, canonicalGhlEventId, eventEndMsGhl, getEventStartDayAmsterdam } from '../lib/planning/ghl-event-core.js';
import { BOOKING_FORM_FIELD_IDS, parseStructuredPriceRulesString } from '../lib/booking-canon-fields.js';
import { logCanonicalAddressRead, readCanonicalAddressLine, splitAddressLineToStraatHuis } from '../lib/ghl-contact-canonical.js';
import { resolveContactCustomFieldId } from '../lib/ghl-custom-fields.js';
import { addAmsterdamCalendarDays, formatYyyyMmDdInAmsterdam, amsterdamCalendarDayBoundsMs } from '../lib/amsterdam-calendar-day.js';
import { SLOT_LABEL_AFTERNOON_NL, SLOT_LABEL_MORNING_NL } from '../lib/planning-work-hours.js';
import { cachedListConfirmedSyntheticEventsForDate } from '../lib/amsterdam-day-read-cache.js';
import { buildPriceMaps, calcAppointmentTotal, computeAppointmentAnalytics } from '../lib/planner-appointment-totals.js';
import { fetchWithRetry } from '../lib/retry.js';
import { listPrices } from '../lib/prices-store.js';
import {
  listAnalyticsAppointmentsByDateRange,
  upsertAnalyticsAppointmentRecord,
} from '../lib/analytics-appointments-cache.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const RESULT_CACHE_TTL_SEC = 5 * 60;
const RECENT_CREATED_LOOKBACK_DAYS = 45;
const CONTACT_CACHE_TTL_SEC = 24 * 60 * 60;
const ANALYTICS_SOURCE = 'planner_feed';
const ANALYTICS_VERSION = 'planner_feed_v5';
const DEFAULT_VAT_FACTOR = 1.21;

const FIELD_IDS = {
  tijdafspraak: 'RfKARymCOYYkufGY053T',
  type_onderhoud: 'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving: 'BBcbPCNA9Eu0Kyi4U1LN',
  prijs: 'HGjlT6ofaBiMz3j2HsXL',
  prijs_regels: 'gPjrUG2eH81PeALh8tVS',
  opmerkingen: 'LCIFALarX3WZI5jsBbDA',
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

function resultCacheKeyFromRange(range, locationId) {
  const loc = String(locationId || ghlLocationIdFromEnv() || '').trim() || 'default';
  const start = String(range?.startDate || '').trim();
  const end = String(range?.endDate || '').trim();
  if (start && end) {
    return `${redisPrefix()}hk:analytics:${loc}:${start}:${end}:${ANALYTICS_VERSION}`;
  }
  return `${redisPrefix()}hk:analytics:${loc}:${String(range?.key || '').trim() || 'unknown'}:${ANALYTICS_VERSION}`;
}

function plannerRangeFromDates(startDate, endDate) {
  const startBounds = amsterdamCalendarDayBoundsMs(startDate);
  const endBounds = amsterdamCalendarDayBoundsMs(endDate);
  return {
    startDate,
    endDate,
    startMs: startBounds?.startMs,
    endMs: endBounds?.endMs,
  };
}

function appointmentServiceDateYmd(appointment) {
  return appointment?.date || eventYmdFromStartMs({ startTime: appointment?.startMs }) || '';
}

function filterAppointmentsInDateRange(appointments, startDate, endDate) {
  return (Array.isArray(appointments) ? appointments : []).filter((a) => {
    if (a?.isCalBlock) return false;
    const d = appointmentServiceDateYmd(a);
    return d && d >= startDate && d <= endDate;
  });
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

function queryFromReq(req) {
  const rawUrl = String(req?.url || '/');
  const parsed = new URL(rawUrl, 'http://localhost');
  return {
    period: parsed.searchParams.get('period') || '',
    startDate: parsed.searchParams.get('startDate') || '',
    endDate: parsed.searchParams.get('endDate') || '',
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
  const url = `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${startMs}&endTime=${endMs}`;
  const response = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
  });
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`GHL calendars/events fout (${response.status}): ${txt.slice(0, 180)}`);
  }
  const data = await response.json().catch(() => ({}));
  const rows = Array.isArray(data?.events) ? data.events : [];
  return { events: rows, calls: 1 };
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

function paymentIsPaid(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return false;
  return t.includes('betaald') || t.includes('paid') || t.includes('afgerond');
}

function normalizeSku(v) {
  return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeNameForMatch(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, ' ')
    .trim();
}

function daysInclusive(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const diff = new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`);
  if (!Number.isFinite(diff) || diff < 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000)) + 1;
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function inclToExcl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return round2(n / DEFAULT_VAT_FACTOR);
}

function toEpochMsFromAny(raw) {
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function appointmentCreatedMs(appointment) {
  const rawPayload = appointment?.raw_payload && typeof appointment.raw_payload === 'object'
    ? appointment.raw_payload
    : appointment?.rawPayload && typeof appointment.rawPayload === 'object'
      ? appointment.rawPayload
      : null;
  const candidates = [
    appointment?.created_at,
    appointment?.createdAt,
    appointment?.dateAdded,
    rawPayload?.created_at,
    rawPayload?.createdAt,
    rawPayload?.dateAdded,
    rawPayload?.created_on,
  ];
  for (const c of candidates) {
    const ms = toEpochMsFromAny(c);
    if (ms) return ms;
  }
  const fallbackStart = toEpochMsFromAny(appointment?.startMs);
  if (fallbackStart) return fallbackStart;
  return 0;
}

function appointmentCreatedIso(appointment) {
  const ms = appointmentCreatedMs(appointment);
  if (!ms) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

function detectAppointmentSource(appointment) {
  const id = String(appointment?.id || '').trim().toLowerCase();
  const job = String(appointment?.jobDescription || '').toLowerCase();
  const notes = String(appointment?.notes || '').toLowerCase();
  if (appointment?.isSyntheticBlockBooking || id.startsWith('hk-b1:')) {
    if (job.includes('online geboekt') || notes.includes('online')) return 'Online boeking';
    return 'Online boeking';
  }
  if (id.startsWith('manual:') || notes.includes('handmatig') || notes.includes('planner')) {
    return 'Handmatig ingepland';
  }
  if (id) return 'GHL';
  return 'Onbekend';
}

function matchPriceForLine(line, maps) {
  const sku = normalizeSku(line?.sku);
  if (sku && maps.bySku.has(sku)) return { row: maps.bySku.get(sku), source: 'SKU' };
  const priceId = String(line?.priceId || line?.price_id || '').trim();
  if (priceId && maps.byId.has(priceId)) return { row: maps.byId.get(priceId), source: 'priceId' };
  const nameKey = normalizeNameForMatch(line?.description || line?.desc || line?.label || line?.name || '');
  if (nameKey && maps.byName.has(nameKey)) return { row: maps.byName.get(nameKey), source: 'naam-match' };
  return { row: null, source: 'geen match' };
}

function hasExplicitCostValue(priceRow) {
  if (!priceRow || typeof priceRow !== 'object') return false;
  const raw = priceRow.inkoopprijs;
  if (raw == null || raw === '') return false;
  return toFiniteNumber(raw) !== null;
}

function buildMarginLineItems(appointment, maps) {
  const lines = [];
  const base = Number(appointment?.price || 0);
  if (base > 0) {
    lines.push({ description: 'Basisprijs', verkoopprijs: base, sku: null, priceId: null });
  }
  const extras = Array.isArray(appointment?.extras) ? appointment.extras : [];
  for (const ex of extras) {
    lines.push({
      description: String(ex?.desc || ex?.label || ex?.name || '').trim() || 'Onbekend',
      verkoopprijs: Number(ex?.price || 0),
      sku: String(ex?.sku || '').trim() || null,
      priceId: String(ex?.priceId || ex?.price_id || '').trim() || null,
    });
  }
  return lines.map((ln) => {
    const matched = matchPriceForLine(ln, maps);
    const verkoop = round2(Number(ln.verkoopprijs || 0));
    const verkoopExcl = inclToExcl(verkoop);
    const hasKnownCost = hasExplicitCostValue(matched?.row);
    const inkoop = hasKnownCost ? round2(Number(matched.row.inkoopprijs || 0)) : null;
    const marge = hasKnownCost ? round2(verkoopExcl - Number(inkoop || 0)) : null;
    return {
      omschrijving: ln.description,
      verkoopprijs: verkoop,
      verkoopprijsExcl: verkoopExcl,
      inkoopprijs: inkoop,
      marge,
      costKnown: hasKnownCost,
      matchBron: matched.source,
      sku: ln.sku || null,
      priceId: ln.priceId || null,
    };
  });
}

function summarizeAppointmentMargins(lineBreakdown, appointment) {
  const totalRevenue = calcAppointmentTotal(appointment);
  const knownRevenueExcl = round2(
    lineBreakdown.reduce((s, ln) => (ln.costKnown ? s + Number(ln.verkoopprijsExcl || 0) : s), 0)
  );
  const totalKnownCost = round2(
    lineBreakdown.reduce((s, ln) => (ln.costKnown ? s + Number(ln.inkoopprijs || 0) : s), 0)
  );
  const totalUnknownRevenue = round2(
    lineBreakdown.reduce((s, ln) => (!ln.costKnown ? s + Number(ln.verkoopprijs || 0) : s), 0)
  );
  const totalKnownMargin = round2(knownRevenueExcl - totalKnownCost);
  const totalMarginPctKnownOnly = knownRevenueExcl > 0 ? Math.round((totalKnownMargin / knownRevenueExcl) * 1000) / 10 : null;
  const hasUnmatchedLines = lineBreakdown.some((ln) => !ln.costKnown);
  const marginReliable = !hasUnmatchedLines;
  return {
    totalRevenue,
    totalKnownRevenueExcl: knownRevenueExcl,
    totalKnownCost,
    totalUnknownRevenue,
    totalKnownMargin,
    totalMarginPctKnownOnly,
    hasUnmatchedLines,
    marginReliable,
  };
}

function buildAppointmentMarginBreakdown(appointments, priceRows) {
  const clients = (Array.isArray(appointments) ? appointments : []).filter((a) => !a.isCalBlock);
  const maps = {
    byId: new Map(priceRows.map((p) => [String(p?.id || '').trim(), p])),
    bySku: new Map(
      priceRows
        .filter((p) => normalizeSku(p?.sku))
        .map((p) => [normalizeSku(p.sku), p])
    ),
    byName: new Map(priceRows.map((p) => [normalizeNameForMatch(p?.description || p?.name || ''), p])),
  };
  return clients.map((a) => {
    const lineBreakdown = buildMarginLineItems(a, maps);
    const summary = summarizeAppointmentMargins(lineBreakdown, a);
    return {
      appointmentId: a.id || '',
      klantnaam: a.name || '',
      adres: a.fullAddressLine || a.address || '',
      datum: a.date || eventYmdFromStartMs({ startTime: a.startMs }) || '',
      dagdeel: a.dayPart || a.timeWindow || '',
      werksoort: a.jobType || 'onbekend',
      omzet: summary.totalRevenue,
      inkoop: summary.totalKnownCost,
      marge: summary.totalKnownMargin,
      margePct: summary.totalMarginPctKnownOnly,
      totalRevenue: summary.totalRevenue,
      totalKnownRevenueExcl: summary.totalKnownRevenueExcl,
      totalKnownCost: summary.totalKnownCost,
      totalUnknownRevenue: summary.totalUnknownRevenue,
      totalKnownMargin: summary.totalKnownMargin,
      totalMarginPctKnownOnly: summary.totalMarginPctKnownOnly,
      hasUnmatchedLines: summary.hasUnmatchedLines,
      marginReliable: summary.marginReliable,
      prijsregels: lineBreakdown,
    };
  });
}

function buildAnalyticsFromAppointments(appointments = []) {
  const clients = appointments.filter((a) => !a.isCalBlock);
  const totaalAfspraken = clients.length;
  const totaleOmzet = Math.round(clients.reduce((s, a) => s + calcAppointmentTotal(a), 0) * 100) / 100;
  const gemiddeldeWaarde = totaalAfspraken ? Math.round((totaleOmzet / totaalAfspraken) * 100) / 100 : 0;
  const openstaandTeFactureren = Math.round(
    clients.reduce((s, a) => (paymentIsPaid(a.paymentStatus) ? s : s + calcAppointmentTotal(a)), 0) * 100
  ) / 100;
  const byType = {};
  for (const a of clients) {
    const t = String(a.jobType || 'onbekend').toLowerCase();
    if (!byType[t]) byType[t] = { jobType: t, aantal: 0, omzet: 0 };
    byType[t].aantal += 1;
    byType[t].omzet = Math.round((byType[t].omzet + calcAppointmentTotal(a)) * 100) / 100;
  }
  const weekMap = {};
  const recentSortStats = { createdBased: 0, fallbackStartMs: 0 };
  const recentAppointments = [...clients]
    .sort((a, b) => {
      const aCreated = appointmentCreatedMs(a);
      const bCreated = appointmentCreatedMs(b);
      return bCreated - aCreated;
    })
    .slice(0, 10)
    .map((a) => {
      const createdCandidates = [a?.created_at, a?.createdAt, a?.dateAdded, a?.raw_payload?.createdAt, a?.rawPayload?.createdAt];
      const hasCreatedSource = createdCandidates.some((v) => toEpochMsFromAny(v));
      if (hasCreatedSource) recentSortStats.createdBased += 1;
      else recentSortStats.fallbackStartMs += 1;
      return {
        id: a.id,
        datum: eventYmdFromStartMs({ startTime: a.startMs }) || '',
        klant: a.name || '',
        adres: a.fullAddressLine || a.address || '',
        werksoort: a.jobType || 'onbekend',
        bedrag: calcAppointmentTotal(a),
        status: a.status || '',
        contactId: a.contactId || '',
      };
    });
  const categoryCostFactor = { installatie: 0.58, reparatie: 0.62, onderhoud: 0.55, onbekend: 0.6 };
  const dayMap = {};
  for (const a of clients) {
    const date = eventYmdFromStartMs({ startTime: a.startMs });
    if (!date) continue;
    const jobType = String(a.jobType || 'onbekend').toLowerCase();
    const total = calcAppointmentTotal(a);
    const factor = Number(categoryCostFactor[jobType] ?? categoryCostFactor.onbekend);
    const margin = total - total * factor;
    if (!dayMap[date]) dayMap[date] = { day: date, omzet: 0, marge: 0, installatie: 0, reparatie: 0, onderhoud: 0 };
    dayMap[date].omzet = Math.round((dayMap[date].omzet + total) * 100) / 100;
    dayMap[date].marge = Math.round((dayMap[date].marge + margin) * 100) / 100;
    if (jobType === 'installatie' || jobType === 'reparatie' || jobType === 'onderhoud') {
      dayMap[date][jobType] = Math.round((Number(dayMap[date][jobType]) + total) * 100) / 100;
    }
    const d = new Date(`${date}T12:00:00Z`);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    const wk = `${d.getUTCFullYear()}-W${String(Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)).padStart(2, '0')}`;
    if (!weekMap[wk]) weekMap[wk] = { week: wk, omzet: 0, marge: 0, installatie: 0, reparatie: 0, onderhoud: 0 };
    weekMap[wk].omzet = Math.round((weekMap[wk].omzet + total) * 100) / 100;
    weekMap[wk].marge = Math.round((weekMap[wk].marge + margin) * 100) / 100;
    if (jobType === 'installatie' || jobType === 'reparatie' || jobType === 'onderhoud') {
      weekMap[wk][jobType] = Math.round((Number(weekMap[wk][jobType]) + total) * 100) / 100;
    }
  }
  const omzetByDay = Object.values(dayMap).sort((a, b) => String(a.day).localeCompare(String(b.day)));
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
    omzetByDay,
    omzetByWeek,
    recentAppointments,
    repeatCustomersPct: repeatPct,
    recentSortStats,
  };
}

function summarizeMarginReliability(breakdownRows = []) {
  const appts = Array.isArray(breakdownRows) ? breakdownRows : [];
  const unmatchedCostLines = appts.reduce(
    (s, appt) => s + (Array.isArray(appt?.prijsregels) ? appt.prijsregels.filter((ln) => !ln?.costKnown).length : 0),
    0
  );
  const unmatchedRevenue = Math.round(appts.reduce((s, appt) => s + Number(appt?.totalUnknownRevenue || 0), 0) * 100) / 100;
  const marginReliableAppointments = appts.filter((appt) => appt?.marginReliable).length;
  const marginUnreliableAppointments = appts.length - marginReliableAppointments;
  const marginReliabilityPct = appts.length ? Math.round((marginReliableAppointments / appts.length) * 1000) / 10 : 100;
  return {
    unmatchedCostLines,
    unmatchedRevenue,
    marginReliableAppointments,
    marginUnreliableAppointments,
    marginReliabilityPct,
  };
}

function buildRecentCreatedAppointmentsFromAll(appointments) {
  return (Array.isArray(appointments) ? appointments : [])
    .filter((a) => !a?.isCalBlock)
    .sort((a, b) => appointmentCreatedMs(b) - appointmentCreatedMs(a))
    .slice(0, 10)
    .map((a) => ({
      id: a.id || '',
      aangemaaktOp: appointmentCreatedIso(a) || '',
      afspraakdatum: eventYmdFromStartMs({ startTime: a.startMs }) || '',
      klant: a.name || '',
      adres: a.fullAddressLine || a.address || '',
      werksoort: a.jobType || 'onbekend',
      bedrag: calcAppointmentTotal(a),
      bron: detectAppointmentSource(a),
    }));
}

async function loadAppointmentsForPlannerAnalytics(range) {
  const today = formatYyyyMmDdInAmsterdam(new Date());
  const lookbackStart = addAmsterdamCalendarDays(today, -(RECENT_CREATED_LOOKBACK_DAYS - 1));
  const lookbackEnd = today;
  const lookbackRange = plannerRangeFromDates(lookbackStart, lookbackEnd);

  if (range.startDate >= lookbackStart && range.endDate <= lookbackEnd) {
    const out = await loadMappedAppointmentsForRange(lookbackRange);
    return {
      kpiAppointments: filterAppointmentsInDateRange(out.appointments, range.startDate, range.endDate),
      recentSourceAppointments: out.appointments,
      ghlCalls: out.ghlCalls,
      uniqueContacts: out.uniqueContacts,
      usedContactCache: out.usedContactCache,
      dayCount: out.dayCount,
    };
  }

  if (range.endDate < lookbackStart || range.startDate > lookbackEnd) {
    const [kpiOut, recentOut] = await Promise.all([
      loadMappedAppointmentsForRange(range),
      loadMappedAppointmentsForRange(lookbackRange),
    ]);
    return {
      kpiAppointments: kpiOut.appointments,
      recentSourceAppointments: recentOut.appointments,
      ghlCalls: Number(kpiOut.ghlCalls || 0) + Number(recentOut.ghlCalls || 0),
      uniqueContacts: Math.max(Number(kpiOut.uniqueContacts || 0), Number(recentOut.uniqueContacts || 0)),
      usedContactCache: Boolean(kpiOut.usedContactCache || recentOut.usedContactCache),
      dayCount: kpiOut.dayCount,
    };
  }

  const unifiedStart = range.startDate < lookbackStart ? range.startDate : lookbackStart;
  const unifiedEnd = range.endDate > lookbackEnd ? range.endDate : lookbackEnd;
  const unifiedRange = plannerRangeFromDates(unifiedStart, unifiedEnd);
  const out = await loadMappedAppointmentsForRange(unifiedRange);
  return {
    kpiAppointments: filterAppointmentsInDateRange(out.appointments, range.startDate, range.endDate),
    recentSourceAppointments: filterAppointmentsInDateRange(out.appointments, lookbackStart, lookbackEnd),
    ghlCalls: out.ghlCalls,
    uniqueContacts: out.uniqueContacts,
    usedContactCache: out.usedContactCache,
    dayCount: daysInclusive(range.startDate, range.endDate),
  };
}

async function readResultCache(range, locationId) {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(resultCacheKeyFromRange(range, locationId));
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function writeResultCache(range, payload, locationId) {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(resultCacheKeyFromRange(range, locationId), JSON.stringify(payload), { ex: RESULT_CACHE_TTL_SEC });
}

function isPlannerFeedResultCacheUsable(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.period || !payload.kpis) return false;
  const source = String(payload?.meta?.analytics_source || '').trim();
  const version = String(payload?.meta?.analytics_version || '').trim();
  return source === ANALYTICS_SOURCE && version === ANALYTICS_VERSION;
}

async function loadMappedAppointmentsForRange(range) {
  const locId = ghlLocationIdFromEnv();
  const calId = ghlCalendarIdFromEnv();
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

  const dayDates = [];
  for (let d = range.startDate; d && d <= range.endDate; d = addAmsterdamCalendarDays(d, 1)) {
    dayDates.push(d);
  }
  const syntheticByDay = await Promise.all(
    dayDates.map((d) => cachedListConfirmedSyntheticEventsForDate(d).catch(() => []))
  );
  for (let i = 0; i < dayDates.length; i += 1) {
    const d = dayDates[i];
    const synthetic = syntheticByDay[i] || [];
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

  return {
    appointments,
    ghlCalls,
    uniqueContacts: uniqueCids.length,
    usedContactCache,
    dayCount: daysInclusive(range.startDate, range.endDate),
  };
}

async function runAnalyticsFromPlannerFeed(rangeInput) {
  const range = rangeInput;
  const locId = ghlLocationIdFromEnv();
  const {
    kpiAppointments,
    recentSourceAppointments,
    ghlCalls: ghaCalls,
    uniqueContacts,
    dayCount,
    usedContactCache,
  } = await loadAppointmentsForPlannerAnalytics(range);
  const analytics = buildAnalyticsFromAppointments(kpiAppointments);
  const recentSortStats = analytics?.recentSortStats || {};
  const analyticsPayload = { ...analytics };
  delete analyticsPayload.recentSortStats;
  const clients = kpiAppointments.filter((a) => !a.isCalBlock);
  const cachedAppointmentRows = await listAnalyticsAppointmentsByDateRange(range.startDate, range.endDate).catch(() => []);
  const cachedByAppointmentId = new Map();
  for (const row of Array.isArray(cachedAppointmentRows) ? cachedAppointmentRows : []) {
    const key = String(row?.appointmentId || row?.appointment_id || '').trim();
    if (key) cachedByAppointmentId.set(key, row);
  }
  const missingAnalyticsAppointments = [];
  const fullMarginBreakdown = [];
  if (clients.length && clients.every((a) => cachedByAppointmentId.has(String(a?.id || '').trim()))) {
    for (const a of clients) {
      const row = cachedByAppointmentId.get(String(a?.id || '').trim()) || {};
      const totalRevenueExcl = round2(Number(row?.totalRevenueExcl ?? row?.total_revenue_excl ?? 0));
      const totalCost = round2(Number(row?.totalCost ?? row?.total_cost ?? 0));
      const margin = round2(Number(row?.margin ?? 0));
      const marginPct = Number(row?.marginPct ?? row?.margin_pct);
      const costKnown = row?.costKnown === true || row?.cost_known === true;
      fullMarginBreakdown.push({
        appointmentId: a.id || '',
        klantnaam: a.name || '',
        adres: a.fullAddressLine || a.address || '',
        datum: a.date || eventYmdFromStartMs({ startTime: a.startMs }) || '',
        dagdeel: a.dayPart || a.timeWindow || '',
        werksoort: a.jobType || 'onbekend',
        omzet: calcAppointmentTotal(a),
        inkoop: totalCost,
        marge: margin,
        margePct: Number.isFinite(marginPct) ? marginPct : null,
        totalRevenue: calcAppointmentTotal(a),
        totalKnownRevenueExcl: totalRevenueExcl,
        totalKnownCost: totalCost,
        totalUnknownRevenue: costKnown ? 0 : calcAppointmentTotal(a),
        totalKnownMargin: margin,
        totalMarginPctKnownOnly: Number.isFinite(marginPct) ? marginPct : null,
        hasUnmatchedLines: !costKnown,
        marginReliable: costKnown,
        prijsregels: [],
      });
    }
  } else {
    const priceRows = await listPrices(locId || 'default').catch(() => []);
    const maps = buildPriceMaps(Array.isArray(priceRows) ? priceRows : []);
    for (const a of clients) {
      const computed = computeAppointmentAnalytics(a, maps);
      const summaryRevenue = calcAppointmentTotal(a);
      const lineBreakdown = Array.isArray(computed?.lineBreakdown) ? computed.lineBreakdown : [];
      const unknownRevenue = round2(
        lineBreakdown.reduce((s, ln) => (!ln.costKnown ? s + Number(ln.verkoopprijs || 0) : s), 0)
      );
      fullMarginBreakdown.push({
        appointmentId: a.id || '',
        klantnaam: a.name || '',
        adres: a.fullAddressLine || a.address || '',
        datum: a.date || eventYmdFromStartMs({ startTime: a.startMs }) || '',
        dagdeel: a.dayPart || a.timeWindow || '',
        werksoort: a.jobType || 'onbekend',
        omzet: summaryRevenue,
        inkoop: computed.totalCost,
        marge: computed.margin,
        margePct: computed.marginPct,
        totalRevenue: summaryRevenue,
        totalKnownRevenueExcl: computed.totalRevenueExcl,
        totalKnownCost: computed.totalCost,
        totalUnknownRevenue: unknownRevenue,
        totalKnownMargin: computed.margin,
        totalMarginPctKnownOnly: computed.totalRevenueExcl > 0 ? computed.marginPct : null,
        hasUnmatchedLines: !computed.costKnown,
        marginReliable: computed.costKnown,
        prijsregels: lineBreakdown,
      });
      const apptDate = a.date || eventYmdFromStartMs({ startTime: a.startMs }) || '';
      if (a?.id && apptDate) {
        missingAnalyticsAppointments.push({
          appointmentId: String(a.id).trim(),
          date: apptDate,
          totalRevenueExcl: computed.totalRevenueExcl,
          totalCost: computed.totalCost,
          margin: computed.margin,
          marginPct: computed.marginPct,
          costKnown: computed.costKnown,
        });
      }
    }
    if (missingAnalyticsAppointments.length) {
      await Promise.allSettled(missingAnalyticsAppointments.map((row) => upsertAnalyticsAppointmentRecord(row)));
    }
  }
  const marginMeta = summarizeMarginReliability(fullMarginBreakdown);
  let recentCreatedAppointments = [];
  let recentCreatedAppointmentsError = '';
  try {
    recentCreatedAppointments = buildRecentCreatedAppointmentsFromAll(recentSourceAppointments);
  } catch (err) {
    recentCreatedAppointments = [];
    recentCreatedAppointmentsError = String(err?.message || err || '').slice(0, 220);
    console.warn('[analytics] recentCreatedAppointments_build_failed', {
      message: recentCreatedAppointmentsError,
      range: `${range.startDate}..${range.endDate}`,
    });
  }
  const rangeDays = daysInclusive(range.startDate, range.endDate);
  const shouldIncludeMarginBreakdown = rangeDays > 0 && rangeDays <= 5;
  const appointmentMarginBreakdown = shouldIncludeMarginBreakdown ? fullMarginBreakdown : [];
  return {
    period: range.period,
    startDate: range.startDate,
    endDate: range.endDate,
    ...analyticsPayload,
    recentCreatedAppointments,
    appointmentMarginBreakdown,
    meta: {
      ghlCalls: ghaCalls,
      uniqueContacts,
      cacheHit: usedContactCache ? 'contacts' : 'none',
      period: range.period,
      generatedAt: new Date().toISOString(),
      analytics_source: ANALYTICS_SOURCE,
      analytics_version: ANALYTICS_VERSION,
      fetchedDays: dayCount,
      marginBreakdownEnabled: shouldIncludeMarginBreakdown,
      unmatchedCostLines: marginMeta.unmatchedCostLines,
      unmatchedRevenue: marginMeta.unmatchedRevenue,
      marginReliableAppointments: marginMeta.marginReliableAppointments,
      marginUnreliableAppointments: marginMeta.marginUnreliableAppointments,
      marginReliabilityPct: marginMeta.marginReliabilityPct,
      analyticsAppointmentsCachedCount: cachedByAppointmentId.size,
      analyticsAppointmentsMissingCount: missingAnalyticsAppointments.length,
      recentCreatedAppointmentsError,
      recentAppointmentsSort: {
        primary: 'created_at|createdAt|dateAdded|raw_payload.createdAt|raw_payload.dateAdded',
        fallback: 'startMs',
        createdBasedCount: Number(recentSortStats?.createdBased || 0),
        fallbackCount: Number(recentSortStats?.fallbackStartMs || 0),
      },
    },
  };
}

async function runAnalytics(rangeInput) {
  const range = rangeInput;
  const { appointments, ghlCalls, uniqueContacts, usedContactCache } = await loadMappedAppointmentsForRange(range);
  const analytics = buildAnalyticsFromAppointments(appointments);
  return {
    period: range.period,
    startDate: range.startDate,
    endDate: range.endDate,
    ...analytics,
    meta: {
      ghlCalls,
      uniqueContacts,
      cacheHit: usedContactCache ? 'contacts' : 'none',
      period: range.period,
      generatedAt: new Date().toISOString(),
      analytics_source: 'ghl',
    },
  };
}

export default async function handler(req, res) {
  try {
    console.log('analytics_handler_start', {
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasSupabaseServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!ensureAuth(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Niet geautoriseerd',
        detail: 'Ongeldige of ontbrekende sessie (header X-HK-Auth).',
      });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const locConfigured = ghlLocationIdFromEnv();
    const calConfigured = ghlCalendarIdFromEnv();
    const hasGhl = Boolean(GHL_API_KEY && locConfigured && calConfigured);
    if (!hasGhl) {
      return res.status(503).json({
        ok: false,
        error: 'Analytics niet beschikbaar',
        detail: 'Zet GHL_API_KEY + GHL_LOCATION_ID + GHL_CALENDAR_ID om planner-feed analytics te gebruiken.',
      });
    }

    const range = buildRangeFromRequest(queryFromReq(req));

    console.log(
      JSON.stringify({
        analytics_env_check: {
          hasGhl,
          vercelEnv: String(process.env.VERCEL_ENV || '').trim() || null,
          rangeKey: range.key,
        },
      })
    );

    const locId = locConfigured;
    const cacheHit = await readResultCache(range, locId);
    const cacheUsable = isPlannerFeedResultCacheUsable(cacheHit);
    if (cacheUsable) {
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
      const payload = await runAnalyticsFromPlannerFeed(range);
      await writeResultCache(range, payload, locId);
      return res.status(200).json({ ok: true, source: 'live', ...payload });
    } catch (err) {
      const fallback = await readResultCache(range, locId);
      const fallbackUsable = isPlannerFeedResultCacheUsable(fallback);
      if (fallbackUsable) {
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
  } catch (err) {
    console.error('analytics_fatal_error', {
      message: err?.message,
      stack: err?.stack?.slice(0, 500),
    });
    return res.status(500).json({
      ok: false,
      error: 'analytics_fatal_error',
      detail: err?.message || 'unknown',
    });
  }
}
