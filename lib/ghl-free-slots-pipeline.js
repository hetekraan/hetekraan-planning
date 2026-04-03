/**
 * GHL GET …/calendars/:id/free-slots → concrete start/end ms per slot.
 * Klantpad gebruikt dit niet meer (block-capacity); pipeline blijft voor eventuele tooling / legacy.
 */

import { ghlDurationMinutesForType, normalizeWorkType } from './booking-blocks.js';
import {
  amsterdamCalendarDayBoundsMs,
  formatYyyyMmDdInAmsterdam,
  hourInAmsterdam,
} from './amsterdam-calendar-day.js';
import { DAYPART_SPLIT_HOUR } from './planning-work-hours.js';
import { stripGhlEnvId } from './ghl-env-ids.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ghlFetchWith429Backoff(url, headers, max429Attempts = 6) {
  for (let a = 0; a < max429Attempts; a++) {
    const r = await fetch(url, { headers });
    if (r.status !== 429) return r;
    if (a === max429Attempts - 1) return r;
    const ra = r.headers.get('retry-after');
    let waitMs = ra ? parseInt(ra, 10) * 1000 : 1000 * Math.pow(2, a);
    if (!Number.isFinite(waitMs) || waitMs < 0) waitMs = 1000 * Math.pow(2, a);
    waitMs = Math.min(waitMs, 60_000);
    console.warn(`[ghl-free-slots-pipeline] free-slots 429 — wacht ${waitMs}ms (${a + 1}/${max429Attempts})`);
    await sleepMs(waitMs);
  }
  return fetch(url, { headers });
}

const GHL_FREE_SLOTS_META_KEYS = new Set([
  'traceId',
  'success',
  'message',
  'error',
  'statusCode',
  'meta',
  'version',
  'warnings',
]);

function filterAsDateKeyedSlotMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GHL_FREE_SLOTS_META_KEYS.has(k)) continue;
    if (!dateRe.test(k)) continue;
    let arr = null;
    if (Array.isArray(v)) arr = v;
    else if (v && typeof v === 'object') {
      if (Array.isArray(v.slots)) arr = v.slots;
      else if (Array.isArray(v.freeSlots)) arr = v.freeSlots;
      else if (Array.isArray(v.availableSlots)) arr = v.availableSlots;
    }
    if (arr) out[k] = arr;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractSlotsObject(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.slots)) return { _all: data.slots };
  const inner =
    data.slots ?? data.data?.slots ?? data.result ?? data.freeSlots ?? data.availability ?? data.data?.result;
  if (inner != null && typeof inner === 'object') {
    if (Array.isArray(inner)) return { _all: inner };
    const byDateInner = filterAsDateKeyedSlotMap(inner);
    if (byDateInner) return byDateInner;
    if (inner.data && typeof inner.data === 'object') {
      const nested = filterAsDateKeyedSlotMap(inner.data);
      if (nested) return nested;
    }
    if (!Array.isArray(inner) && Object.keys(inner).length > 0) {
      const onlyMeta = Object.keys(inner).every((k) => GHL_FREE_SLOTS_META_KEYS.has(k));
      if (!onlyMeta) return inner;
    }
  }
  const rootMap = filterAsDateKeyedSlotMap(data);
  if (rootMap) return rootMap;
  if (data.data && typeof data.data === 'object') {
    const inData = filterAsDateKeyedSlotMap(data.data);
    if (inData) return inData;
  }
  return null;
}

function isEmptyFreeSlotsSuccess(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.error || (typeof data.statusCode === 'number' && data.statusCode >= 400)) return false;
  const s = data.slots;
  if (s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 0) return true;
  return false;
}

function coercedEpochMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? Math.round(raw * 1000) : raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return NaN;
      return n < 1e12 ? Math.round(n * 1000) : n;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

export function slotStartMs(slot, depth = 0) {
  if (slot == null || depth > 3) return NaN;
  if (typeof slot === 'string' || typeof slot === 'number') return coercedEpochMs(slot);
  if (typeof slot !== 'object') return NaN;
  const raw =
    slot.startTime ??
    slot.start ??
    slot.from ??
    slot.bookingStartTime ??
    slot.booking_start_time ??
    slot.slotTime ??
    slot.dateTime ??
    slot.time ??
    slot.startDateTime;
  const direct = coercedEpochMs(raw);
  if (!Number.isNaN(direct)) return direct;
  const nested =
    slot.calendarEvent || slot.calendar_event || slot.event || slot.appointment;
  if (nested && typeof nested === 'object') return slotStartMs(nested, depth + 1);
  return NaN;
}

function slotEndMs(slot, startMs, depth = 0) {
  if (slot == null || depth > 3) return NaN;
  if (typeof slot === 'string' || typeof slot === 'number') return NaN;
  if (typeof slot !== 'object') return NaN;
  const raw =
    slot.endTime ??
    slot.end ??
    slot.to ??
    slot.slotEndTime ??
    slot.endDateTime ??
    slot.bookingEndTime;
  const direct = coercedEpochMs(raw);
  if (!Number.isNaN(direct) && direct > startMs) return direct;
  const nested =
    slot.calendarEvent || slot.calendar_event || slot.event || slot.appointment;
  if (nested && typeof nested === 'object') return slotEndMs(nested, startMs, depth + 1);
  return NaN;
}

/**
 * @param {object} slotsObj — extractSlotsObject-resultaat
 * @param {{ calendarId: string, workType: string }} ctx
 * @returns {Array<{ startMs: number, endMs: number, dateStr: string, block: string, dateLabel: string, blockLabel: string, timeLabel: string, id: string }>}
 */
export function slotsObjectToConcreteList(slotsObj, { calendarId, workType }) {
  if (!slotsObj || typeof slotsObj !== 'object') return [];
  const wt = normalizeWorkType(workType);
  const durationMin = ghlDurationMinutesForType(wt);
  const seen = new Set();
  const out = [];

  for (const arr of Object.values(slotsObj)) {
    const list = Array.isArray(arr) ? arr : [];
    for (const el of list) {
      const startMs = slotStartMs(el);
      if (!Number.isFinite(startMs) || Number.isNaN(startMs)) continue;
      if (seen.has(startMs)) continue;
      seen.add(startMs);

      let endMs = slotEndMs(el, startMs);
      if (!Number.isFinite(endMs) || endMs <= startMs) {
        endMs = startMs + durationMin * 60_000;
      }

      const dateStr = formatYyyyMmDdInAmsterdam(new Date(startMs));
      if (!dateStr) continue;
      const h = hourInAmsterdam(startMs);
      const block = h < DAYPART_SPLIT_HOUR ? 'morning' : 'afternoon';
      const blockLabel = block === 'morning' ? 'ochtend' : 'middag';

      const dayBounds = amsterdamCalendarDayBoundsMs(dateStr);
      const dateLabel = dayBounds
        ? new Date(dayBounds.startMs + 12 * 3600000).toLocaleDateString('nl-NL', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'Europe/Amsterdam',
          })
        : dateStr;

      const tf = new Intl.DateTimeFormat('nl-NL', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Amsterdam',
      });
      const timeLabel = `${tf.format(new Date(startMs))}–${tf.format(new Date(endMs))}`;

      out.push({
        id: `s_${startMs}`,
        startMs,
        endMs,
        dateStr,
        block,
        blockLabel,
        dateLabel,
        timeLabel,
      });
    }
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * @returns {Promise<{ ok: boolean, slotsObj?: object, error?: string }>}
 */
export async function fetchGhlFreeSlotsObject({
  calendarId,
  locationId,
  startMs,
  endMs,
  apiKey,
}) {
  const baseQs = new URLSearchParams({
    startDate: String(startMs),
    endDate: String(endMs),
    timezone: 'Europe/Amsterdam',
  });
  const withLoc = new URLSearchParams(baseQs);
  if (locationId) withLoc.set('locationId', locationId);

  const encCal = encodeURIComponent(calendarId);
  const userIdOpt = stripGhlEnvId(
    process.env.GHL_FREE_SLOTS_USER_ID ||
      process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID ||
      process.env.GHL_BLOCK_SLOT_USER_ID
  );
  const withLocUser = new URLSearchParams(withLoc);
  if (userIdOpt) withLocUser.set('userId', userIdOpt);

  const urlAttempts = [
    `${GHL_BASE}/calendars/${encCal}/free-slots?${withLoc}`,
    ...(userIdOpt ? [`${GHL_BASE}/calendars/${encCal}/free-slots?${withLocUser}`] : []),
    `${GHL_BASE}/calendars/${encCal}/free-slots?${baseQs}`,
  ];

  const versions = ['2021-04-15', '2021-07-28'];
  let lastErr = '';
  const seen = new Set();
  for (const url of urlAttempts) {
    if (seen.has(url)) continue;
    seen.add(url);
    for (const Version of versions) {
      const r = await ghlFetchWith429Backoff(url, {
        Authorization: `Bearer ${apiKey}`,
        Version,
      });
      const txt = await r.text().catch(() => '');
      if (!r.ok) {
        lastErr = `${r.status} ${txt.slice(0, 200)}`;
        continue;
      }
      let data;
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        lastErr = 'JSON parse';
        continue;
      }
      const slotsObj = extractSlotsObject(data);
      if (slotsObj) return { ok: true, slotsObj };
      if (isEmptyFreeSlotsSuccess(data)) return { ok: true, slotsObj: {} };
      const keys = Object.keys(data).slice(0, 14).join(', ');
      lastErr = `Geen slots-object in response (top keys: ${keys || '—'})`;
    }
  }
  return { ok: false, error: lastErr || 'free-slots mislukt' };
}
