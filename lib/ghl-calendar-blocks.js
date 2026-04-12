/**
 * GHL “block slots” — officiële manier om tijd te blokken (los van klantafspraken).
 * POST …/calendars/events/block-slots, GET …/calendars/blocked-slots
 *
 * Overlap met “werkdag” gebruikt WORK_DAY_* uit planning-work-hours.js (intern 08–18), niet het klantblok 09–13 / 13–17.
 *
 * Operatie: het dashboard zet een Amsterdam-datum als GHL-blokslot (standaard 00:00–23:59; optioneel een
 * wandtijdvenster, zie `postAmsterdamWallBlockWindow`). In de online flow
 * (suggest / invite / confirm) valt de **datum volledig weg** zodra **enige** blok-achtige tijd de planningdag
 * 08:00–18:00 Amsterdam raakt — óók bij blokken die alleen in GHL korter zijn (bijv. ochtend).
 */

import { amsterdamCalendarDayBoundsMs, hourInAmsterdam } from './amsterdam-calendar-day.js';
import { amsterdamWallTimeToDate, formatAmsterdamWallIso8601Offset } from './amsterdam-wall-time.js';
import {
  DAYPART_SPLIT_HOUR,
  WORK_DAY_END_HOUR,
  WORK_DAY_START_HOUR,
} from './planning-work-hours.js';
import { availabilityDebugEnabled, logAvailability } from './availability-debug.js';
import { getCustomerDayFullFlag } from './customer-day-full-store.js';
import { stripGhlEnvId } from './ghl-env-ids.js';
import { fetchWithRetry } from './retry.js';

/**
 * Personal “Planning Jerry” block-slots (POST zonder event-calendarId).
 * Unblock/list moet deze user altijd meescannen naast env-users.
 */
export const HK_DEFAULT_BLOCK_SLOT_USER_ID = 'VHbv9VzNnzAXgudbG318';

/**
 * Eerste gekoppelde GHL-user van de kalender (zelfde bron als vroeger alleen voor POST block-slots).
 * @returns {string} user UUID of ''
 */
async function fetchCalendarAssignedUserFromGhlApi(base, apiKey, locationId, calendarId) {
  const loc = stripGhlEnvId(locationId);
  const cal = stripGhlEnvId(calendarId);
  if (!apiKey || !loc || !cal) return '';
  const urls = [
    `${base}/calendars/${encodeURIComponent(cal)}?locationId=${encodeURIComponent(loc)}`,
    `${base}/locations/${encodeURIComponent(loc)}/calendars/${encodeURIComponent(cal)}`,
  ];
  for (const url of urls) {
    for (const Version of ['2021-04-15', '2021-07-28']) {
      try {
        const r = await fetchWithRetry(
          url,
          {
            headers: { Authorization: `Bearer ${apiKey}`, Version },
          },
          0
        );
        if (!r.ok) continue;
        const j = await r.json().catch(() => ({}));
        const c = j?.calendar || j?.data || j;
        const uid =
          c?.userId ??
          c?.primaryUserId ??
          c?.assignedUserId ??
          c?.teamMembers?.[0]?.userId ??
          c?.teamMembers?.[0]?.id ??
          (Array.isArray(c?.calendarUserIds) ? c.calendarUserIds[0] : null) ??
          (Array.isArray(c?.memberIds) ? c.memberIds[0] : null);
        if (uid != null && String(uid).trim()) return String(uid).trim();
      } catch {
        /* ignore */
      }
    }
  }
  return '';
}

/**
 * Één canonical `assignedUserId` voor POST block-slots, GET blocked-slots, DELETE en availability-checks.
 * Volgorde: GHL_BLOCK_SLOT_USER_ID → GHL_APPOINTMENT_ASSIGNED_USER_ID → kalender-metadata → vaste fallback.
 */
export async function resolveBlockSlotAssignedUserId(base, apiKey, locationId, calendarId) {
  const fromEnv =
    stripGhlEnvId(process.env.GHL_BLOCK_SLOT_USER_ID) ||
    stripGhlEnvId(process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID);
  if (fromEnv) return fromEnv;
  const fromCal = await fetchCalendarAssignedUserFromGhlApi(base, apiKey, locationId, calendarId);
  if (fromCal) return fromCal;
  return HK_DEFAULT_BLOCK_SLOT_USER_ID;
}

/** DELETE block-slots / fallback: beide versies. */
const API_VERSIONS = ['2021-07-28', '2021-04-15'];

/** POST block-slots: GHL/marketplace — uitsluitend 2021-04-15 (geen 2021-07-28 voor deze route). */
const BLOCK_SLOT_POST_VERSION = '2021-04-15';

function stripGhlEnvIdLocal(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function extractBlockedSlotsList(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.result)) return data.result;
  const tryKeys = [
    'blockedSlots',
    'blocked_slots',
    'blockSlots',
    'block_slots',
    'events',
    'slots',
    'blockedSlot',
    'records',
  ];
  for (const k of tryKeys) {
    const v = data[k];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(data)) return data;
  if (data.data && typeof data.data === 'object') {
    const inner = extractBlockedSlotsList(data.data);
    if (inner.length) return inner;
  }
  return [];
}

/** Zet GHL-tijd naar ms zodat api/ghl eventStartMsGhl het herkent. */
function coerceBlockTimeToMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    const s = v.trim();
    if (/^\d{10,16}$/.test(s)) {
      const n = parseInt(s, 10);
      return n < 1e12 ? n * 1000 : n;
    }
  }
  return NaN;
}

/**
 * Haalt geblokkeerde slots op en zet ze om naar event-achtige objecten voor het dashboard.
 *
 * GHL GET /calendars/blocked-slots:
 * - Met **assignedUserId**: alleen `locationId` + `startTime`/`endTime` (ms) + `userId` (en fallback
 *   `assignedUserId` als querynaam) — **geen calendarId** (personal blocks zonder event-kalender).
 * - Zonder user: oude variant met `calendarId` (en evt. zonder kalender) voor event-calendars.
 *
 * @param {object} opts
 * @param {boolean} [opts.calendarScopedOnly] — alleen GET met calendarId (geen user-wide blocked-slots zonder kalender).
 * @param {string|null} [opts.assignedUserId] — GHL userId voor blocked-slots (zelfde als bij POST block-slots).
 */
export async function fetchBlockedSlotsAsEvents(
  base,
  {
    locationId,
    calendarId,
    startMs,
    endMs,
    apiKey,
    calendarScopedOnly = false,
    assignedUserId = null,
  }
) {
  if (!apiKey || !locationId || startMs == null || endMs == null) return [];
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  const uid =
    assignedUserId != null && String(assignedUserId).trim() ? String(assignedUserId).trim() : '';
  const versions = ['2021-04-15', '2021-07-28'];
  const byId = new Map();

  const runFetchQuery = async (version, queryExtra) => {
    let url = `${base}/calendars/blocked-slots?locationId=${encodeURIComponent(locationId)}&startTime=${startMs}&endTime=${endMs}`;
    if (queryExtra) url += `&${queryExtra}`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: version },
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const list = extractBlockedSlotsList(data);
    for (const item of list) {
      const ev = normalizeBlockedToEvent(item);
      if (!ev) continue;
      const key = String(ev.id || `${ev.startTime}-${ev.endTime}`);
      if (!byId.has(key)) byId.set(key, ev);
    }
  };

  try {
    for (const version of versions) {
      if (uid) {
        await runFetchQuery(version, `userId=${encodeURIComponent(uid)}`);
        await runFetchQuery(version, `assignedUserId=${encodeURIComponent(uid)}`);
        if (cal) {
          await runFetchQuery(
            version,
            `userId=${encodeURIComponent(uid)}&calendarId=${encodeURIComponent(cal)}`
          );
          await runFetchQuery(
            version,
            `assignedUserId=${encodeURIComponent(uid)}&calendarId=${encodeURIComponent(cal)}`
          );
        }
      }
      if (cal && calendarScopedOnly) {
        await runFetchQuery(version, `calendarId=${encodeURIComponent(cal)}`);
      } else if (cal) {
        await runFetchQuery(version, `calendarId=${encodeURIComponent(cal)}`);
        if (!calendarScopedOnly && !uid) await runFetchQuery(version, '');
      }
    }
  } catch {
    return Array.from(byId.values());
  }
  return Array.from(byId.values());
}

/** Of een blocked-slot-event (genormaliseerd) de ms-range (qStart..qEnd) raakt. */
function blockedSlotEventOverlapsMs(ev, qStart, qEnd) {
  const s = blockStartMs(ev);
  const e = blockEndMs(ev);
  if (Number.isNaN(s) || Number.isNaN(e)) return true;
  return s < qEnd && e > qStart;
}

function blockStartMs(b) {
  const s = b.startTime ?? b.start ?? b.start_time ?? b.from;
  if (s == null) return NaN;
  const coerced = coerceBlockTimeToMs(s);
  if (!Number.isNaN(coerced)) return coerced;
  if (typeof s === 'number') return s < 1e12 ? Math.round(s * 1000) : s;
  const t = Date.parse(String(s));
  return Number.isNaN(t) ? NaN : t;
}

function blockEndMs(b) {
  const e = b.endTime ?? b.end ?? b.end_time ?? b.to;
  if (e == null) return NaN;
  const coerced = coerceBlockTimeToMs(e);
  if (!Number.isNaN(coerced)) return coerced;
  if (typeof e === 'number') return e < 1e12 ? Math.round(e * 1000) : e;
  const t = Date.parse(String(e));
  return Number.isNaN(t) ? NaN : t;
}

function blockedSlotRowLooksReal(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.id != null && String(b.id).trim()) return true;
  if (b.eventId != null && String(b.eventId).trim()) return true;
  if (b.blockedSlotId != null && String(b.blockedSlotId).trim()) return true;
  if (b.blockId != null && String(b.blockId).trim()) return true;
  return false;
}

/** GHL stuurt isBlocked soms als string "true" of 1. */
function truthyBlockedFlag(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

function truthyAllDay(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/** Zelfde titels/vlaggen als api/ghl getAppointments — blok staat vaak alleen in calendars/events. */
export const GHL_BLOCK_LIKE_TITLE_RE =
  /geblokkeerd|dag\s*geblok|blokslot|blocked\s*time|block\s*slot|niet\s*beschikbaar|afwezig|gesloten|unavailable|\bbusy\b|\bhold\b/i;

export function ghlCalendarEventStartMs(e) {
  const candidates = [
    e?.startTime,
    e?.start_time,
    e?.start,
    e?.appointmentStartTime,
    e?.appointment?.startTime,
    e?.calendarEvent?.startTime,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'number') {
      const ms = c < 1e12 ? Math.round(c * 1000) : c;
      if (!Number.isNaN(ms)) return ms;
    }
    if (typeof c === 'string') {
      const t = Date.parse(c);
      if (!Number.isNaN(t)) return t;
    }
  }
  return NaN;
}

export function ghlCalendarEventEndMs(e) {
  const candidates = [
    e?.endTime,
    e?.end_time,
    e?.end,
    e?.appointmentEndTime,
    e?.appointment?.endTime,
    e?.calendarEvent?.endTime,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'number') {
      const ms = c < 1e12 ? Math.round(c * 1000) : c;
      if (!Number.isNaN(ms)) return ms;
    }
    if (typeof c === 'string') {
      const t = Date.parse(c);
      if (!Number.isNaN(t)) return t;
    }
  }
  return NaN;
}

export function markBlockLikeOnCalendarEvents(events) {
  if (!Array.isArray(events)) return;
  for (const e of events) {
    if (!e || typeof e !== 'object' || e._hkGhlBlockSlot) continue;
    const ce = e.calendarEvent || {};
    if (
      truthyBlockedFlag(ce.isBlocked) ||
      truthyBlockedFlag(e.isBlocked) ||
      truthyBlockedFlag(ce.blocked) ||
      truthyBlockedFlag(e.blocked)
    ) {
      e._hkGhlBlockSlot = true;
      continue;
    }
    const evtType = String(e.eventType || ce.eventType || e.type || ce.type || '').toLowerCase();
    if (evtType.includes('block') || evtType === 'busy' || evtType.includes('unavailable')) {
      e._hkGhlBlockSlot = true;
      continue;
    }
    if (truthyAllDay(ce.allDay) || truthyAllDay(e.allDay) || truthyAllDay(ce.isFullDay) || truthyAllDay(e.isFullDay)) {
      e._hkGhlBlockSlot = true;
      continue;
    }
    const title = String(e.title || ce.title || '').trim();
    if (title && GHL_BLOCK_LIKE_TITLE_RE.test(title)) {
      e._hkGhlBlockSlot = true;
      continue;
    }
    const noContact = !(e.contactId || e.contact_id);
    const blockedStatus = String(ce.appointmentStatus || e.appointmentStatus || '').toLowerCase();
    if (noContact && !title && blockedStatus.includes('block')) {
      e._hkGhlBlockSlot = true;
    }
  }
}

/**
 * Minstens één GHL-blokslot raakt werktijd (WORK_DAY_START_HOUR–WORK_DAY_END_HOUR) Amsterdam.
 */
export async function dayHasBlockedSlotsOverlappingWorkHours(
  base,
  { locationId, calendarId, apiKey, calendarScopedOnly = false, assignedUserId = null },
  dateStr,
  debugStats = null
) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds || !apiKey || !locationId) return false;
  const workStart = amsterdamWallTimeToDate(dateStr, WORK_DAY_START_HOUR, 0)?.getTime();
  const workEnd = amsterdamWallTimeToDate(dateStr, WORK_DAY_END_HOUR, 0)?.getTime();
  if (workStart == null || workEnd == null) return false;
  const slots = await fetchBlockedSlotsAsEvents(base, {
    locationId,
    calendarId,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    apiKey,
    calendarScopedOnly,
    assignedUserId,
  });
  if (debugStats && typeof debugStats === 'object') {
    debugStats.blockedSlotRowsInRange = slots.length;
  }
  for (const b of slots) {
    const s = blockStartMs(b);
    let e = blockEndMs(b);
    if (Number.isNaN(s)) {
      if (blockedSlotRowLooksReal(b)) return true;
      continue;
    }
    if (Number.isNaN(e)) e = bounds.endMs;
    if (s < workEnd && e > workStart) return true;
  }
  return false;
}

/**
 * Geblokkeerde slots + blok-achtige agenda-events die een gegeven ms-range op dateStr raken.
 * (Zelfde bronnen als full-day idempotency, maar overlap t.o.v. `rangeStartMs`–`rangeEndMs`.)
 */
export async function blockLikeOverlapsAmsterdamMsRange(
  base,
  { locationId, calendarId, apiKey, assignedUserId = null },
  dateStr,
  rangeStartMs,
  rangeEndMs
) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds || !apiKey || !locationId) return false;
  if (rangeStartMs == null || rangeEndMs == null || rangeStartMs >= rangeEndMs) return false;

  const slots = await fetchBlockedSlotsAsEvents(base, {
    locationId,
    calendarId,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    apiKey,
    calendarScopedOnly: false,
    assignedUserId,
  });
  for (const b of slots) {
    if (blockedSlotEventOverlapsMs(b, rangeStartMs, rangeEndMs)) return true;
  }

  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return false;
  const url = `${base}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(cal)}&startTime=${bounds.startMs}&endTime=${bounds.endMs}`;
  for (const Version of ['2021-04-15', '2021-07-28']) {
    const res = await fetchWithRetry(
      url,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Version },
      },
      0
    );
    if (!res.ok) continue;
    const data = await res.json().catch(() => ({}));
    const events = [...(data?.events || [])];
    markBlockLikeOnCalendarEvents(events);
    for (const e of events) {
      if (!e._hkGhlBlockSlot) continue;
      const s = ghlCalendarEventStartMs(e);
      let eMs = ghlCalendarEventEndMs(e);
      if (Number.isNaN(s)) return true;
      if (Number.isNaN(eMs)) eMs = bounds.endMs;
      if (s < rangeEndMs && eMs > rangeStartMs) return true;
    }
  }
  return false;
}

/**
 * GET /calendars/events voor deze kalenderdag: blok-achtige items die werktijd Amsterdam raken?
 * Aanvulling op blocked-slots (sommige “Dag geblokkeerd” staan alleen als event op de kalender).
 */
export async function dayHasBlockLikeCalendarEventsOverlappingWorkHours(
  base,
  { locationId, calendarId, apiKey },
  dateStr
) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds || !apiKey || !locationId) return false;
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return false;
  const workStart = amsterdamWallTimeToDate(dateStr, WORK_DAY_START_HOUR, 0)?.getTime();
  const workEnd = amsterdamWallTimeToDate(dateStr, WORK_DAY_END_HOUR, 0)?.getTime();
  if (workStart == null || workEnd == null) return false;
  const url = `${base}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(cal)}&startTime=${bounds.startMs}&endTime=${bounds.endMs}`;
  for (const Version of ['2021-04-15', '2021-07-28']) {
    const res = await fetchWithRetry(
      url,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Version },
      },
      0
    );
    if (!res.ok) continue;
    const data = await res.json().catch(() => ({}));
    const events = [...(data?.events || [])];
    markBlockLikeOnCalendarEvents(events);
    for (const e of events) {
      if (!e._hkGhlBlockSlot) continue;
      const s = ghlCalendarEventStartMs(e);
      let eMs = ghlCalendarEventEndMs(e);
      if (Number.isNaN(s)) return true;
      if (Number.isNaN(eMs)) eMs = bounds.endMs;
      if (s < workEnd && eMs > workStart) return true;
    }
  }
  return false;
}

/**
 * Dag skippen bij tijdvoorstellen / boeken: blocked-slots API + block-achtige events uit calendars/events.
 * Operatief: bij **enige** overlap van blok met de interne planningdag 08:00–18:00 Amsterdam gaat de **hele**
 * kalenderdatum dicht in suggest/invite/confirm (niet alleen een dagdeel).
 * @param {object} opts
 * @param {string|null} [opts.assignedUserId] — GET blocked-slots op userId (personal blocks zonder event-calendar).
 */
export async function dayHasCustomerBlockingOverlap(
  base,
  { locationId, calendarId, apiKey, assignedUserId = null },
  dateStr
) {
  const dbg = availabilityDebugEnabled();
  const ghlProbe = dbg
    ? {
        timeZone: 'Europe/Amsterdam',
        workHoursAmsterdam: `${WORK_DAY_START_HOUR}:00–${WORK_DAY_END_HOUR}:00`,
      }
    : null;

  const locForFull = locationId != null ? String(locationId).trim() : '';
  if (locForFull && dateStr) {
    try {
      if (await getCustomerDayFullFlag(locForFull, dateStr)) {
        if (dbg) {
          logAvailability('customer_day_blocked', {
            dateStr,
            reason: 'customer_day_full',
            ghlFromApi: ghlProbe,
          });
        }
        return true;
      }
    } catch (err) {
      if (dbg) {
        logAvailability('customer_day_full_check_error', {
          dateStr,
          err: String(err?.message || err),
        });
      }
    }
  }

  if (
    await dayHasBlockedSlotsOverlappingWorkHours(
      base,
      { locationId, calendarId, apiKey, assignedUserId },
      dateStr,
      ghlProbe
    )
  ) {
    if (dbg) {
      logAvailability('customer_day_blocked', {
        dateStr,
        reason: 'blocked_slots_overlap_work_hours',
        assignedUserId: assignedUserId ? '[set]' : null,
        ghlFromApi: ghlProbe,
      });
    }
    return true;
  }
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds || !apiKey || !locationId) return false;
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return false;
  if (dbg) {
    ghlProbe.dayBoundsMs = { start: bounds.startMs, end: bounds.endMs };
    ghlProbe.calendarId = cal;
  }
  const url = `${base}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(cal)}&startTime=${bounds.startMs}&endTime=${bounds.endMs}`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
  });
  if (!res.ok) {
    if (dbg) {
      logAvailability('customer_day_blocking_check_incomplete', {
        dateStr,
        reason: 'calendar_events_fetch_not_ok',
        httpStatus: res.status,
      });
    }
    return false;
  }
  const data = await res.json().catch(() => ({}));
  let events = [...(data?.events || [])];
  if (dbg) ghlProbe.calendarEventsRawCount = events.length;
  const blockedMerged = await fetchBlockedSlotsAsEvents(base, {
    locationId,
    calendarId,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    apiKey,
    assignedUserId,
  });
  if (dbg) ghlProbe.blockedSlotsMergedForDayCount = blockedMerged.length;
  events = events.concat(blockedMerged);
  markBlockLikeOnCalendarEvents(events);
  if (dbg) {
    const blockLike = events.filter((e) => e._hkGhlBlockSlot);
    ghlProbe.afterMergeEventCount = events.length;
    ghlProbe.blockLikeEventCount = blockLike.length;
    ghlProbe.blockLikeTitleSample = blockLike.slice(0, 4).map((e) =>
      String(e.title || e.calendarEvent?.title || '').slice(0, 80)
    );
  }
  const workStart = amsterdamWallTimeToDate(dateStr, WORK_DAY_START_HOUR, 0)?.getTime();
  const workEnd = amsterdamWallTimeToDate(dateStr, WORK_DAY_END_HOUR, 0)?.getTime();
  if (workStart == null || workEnd == null) return false;
  for (const e of events) {
    if (!e._hkGhlBlockSlot) continue;
    const s = ghlCalendarEventStartMs(e);
    let eMs = ghlCalendarEventEndMs(e);
    if (Number.isNaN(s)) {
      if (dbg) {
        logAvailability('customer_day_blocked', {
          dateStr,
          reason: 'block_like_event_invalid_start_treated_as_block',
          ghlFromApi: ghlProbe,
        });
      }
      return true;
    }
    if (Number.isNaN(eMs)) eMs = bounds.endMs;
    if (s < workEnd && eMs > workStart) {
      if (dbg) {
        logAvailability('customer_day_blocked', {
          dateStr,
          reason: 'block_like_event_overlaps_work_hours',
          ghlFromApi: ghlProbe,
        });
      }
      return true;
    }
  }
  /** Langdurige agenda-item zonder contact (≥6 uur) dat werktijd raakt — vaak interne/vakantie-blok, geen klantafspraak. */
  if (process.env.GHL_SKIP_LONG_HOLD_HEURISTIC !== 'true') {
    const minHoldMs = 6 * 3600000;
    for (const e of events) {
      if (e._hkGhlBlockSlot) continue;
      const cid = e.contactId || e.contact_id || e.contact?.id;
      if (cid) continue;
      const s = ghlCalendarEventStartMs(e);
      const eMs = ghlCalendarEventEndMs(e);
      if (Number.isNaN(s) || Number.isNaN(eMs) || eMs <= s) continue;
      if (eMs - s < minHoldMs) continue;
      if (s < workEnd && eMs > workStart) {
        if (dbg) {
          logAvailability('customer_day_blocked', {
            dateStr,
            reason: 'long_hold_no_contact_overlaps_work_hours',
            ghlFromApi: ghlProbe,
          });
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * Sync: alleen env + vaste fallback (geen kalender-lookup).
 * Voor HTTP-routes: gebruik `resolveBlockSlotAssignedUserId` zodat POST/GET/DELETE dezelfde user gebruiken.
 */
export function resolveAssignedUserIdForBlockedSlotQueries() {
  return (
    stripGhlEnvId(process.env.GHL_BLOCK_SLOT_USER_ID) ||
    stripGhlEnvId(process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID) ||
    HK_DEFAULT_BLOCK_SLOT_USER_ID
  );
}

/**
 * Mag een klant op deze dag niet online boeken? (Ja = geblokkeerd.)
 * `dateStr`: YYYY-MM-DD = kalenderdag Europe/Amsterdam (amsterdamCalendarDayBoundsMs);
 * overlap met werktijd via WORK_DAY_* in planning-work-hours.js.
 */
export async function isCustomerBookingBlockedOnAmsterdamDate(base, ctx, dateStr) {
  return dayHasCustomerBlockingOverlap(base, ctx, dateStr);
}

/** Startvelden voor ochtend/middag-split (zelfde als confirm-booking). */
export function ghlEventStartRaw(e) {
  return (
    e?.startTime ??
    e?.start_time ??
    e?.start ??
    e?.appointmentStartTime ??
    e?.appointment?.startTime ??
    e?.calendarEvent?.startTime
  );
}

export function suggestEventInMorningHalf(e) {
  const raw = ghlEventStartRaw(e);
  if (raw == null) return false;
  return hourInAmsterdam(raw) < DAYPART_SPLIT_HOUR;
}

export function suggestEventInAfternoonHalf(e) {
  const raw = ghlEventStartRaw(e);
  if (raw == null) return false;
  return hourInAmsterdam(raw) >= DAYPART_SPLIT_HOUR;
}

function normalizeBlockedToEvent(s) {
  if (!s || typeof s !== 'object') return null;
  const id =
    s.id ??
    s.eventId ??
    s.blockedSlotId ??
    s.blockId ??
    s.slotId ??
    s._id ??
    s.blockedSlot?.id ??
    s.data?.id ??
    s.calendarEvent?.id;
  const rawStart = s.startTime ?? s.start ?? s.from ?? s.start_time;
  const rawEnd = s.endTime ?? s.end ?? s.to ?? s.end_time;
  let startMs = coerceBlockTimeToMs(rawStart);
  let endMs = coerceBlockTimeToMs(rawEnd);
  if (Number.isNaN(startMs) && Number.isNaN(endMs) && id == null) return null;
  if (Number.isNaN(endMs) && !Number.isNaN(startMs)) endMs = startMs + 60 * 60 * 1000;
  const startOut = Number.isNaN(startMs) ? rawStart : startMs;
  const endOut = Number.isNaN(endMs) ? rawEnd ?? rawStart : endMs;
  return {
    id: id != null ? String(id) : `hk_block_${String(startOut)}`,
    title: s.title || s.name || 'Agenda geblokkeerd',
    startTime: startOut,
    endTime: endOut,
    contactId: undefined,
    _hkGhlBlockSlot: true,
  };
}

function parseGhlErrorBody(txt) {
  let data = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    return { data: {}, detail: String(txt || '').slice(0, 400) };
  }
  const errObj = data?.error;
  const errFromObj =
    errObj && typeof errObj === 'object' && typeof errObj.message === 'string' ? errObj.message : '';
  const metaErr =
    Array.isArray(data?.meta?.errors) &&
    data.meta.errors
      .map((e) => {
        if (e == null) return '';
        if (typeof e === 'string') return e;
        const path = e.path != null ? `${e.path}: ` : '';
        return `${path}${e?.message || e?.msg || JSON.stringify(e)}`;
      })
      .filter(Boolean)
      .join('; ');
  let msg =
    (typeof data?.message === 'string' && data.message) ||
    errFromObj ||
    (typeof errObj === 'string' && errObj) ||
    (Array.isArray(data?.errors) &&
      data.errors.map((e) => e?.message || e?.msg || JSON.stringify(e)).filter(Boolean).join('; ')) ||
    String(txt || '').slice(0, 400);
  if (metaErr) {
    const m = String(msg || '').trim();
    msg = m && !m.includes(metaErr.slice(0, Math.min(30, metaErr.length))) ? `${m} — ${metaErr}` : m || metaErr;
  }
  const issues =
    Array.isArray(data?.issues) &&
    data.issues.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).filter(Boolean).join('; ');
  if (issues) {
    const m = String(msg || '').trim();
    msg = m && !m.includes(issues.slice(0, 40)) ? `${m} — ${issues}` : m || issues;
  }
  if (String(msg).trim() === 'Unprocessable Entity' && data && typeof data === 'object') {
    const extra = JSON.stringify(data).slice(0, 350);
    if (extra.length > 30) msg = `${msg} — ${extra}`;
  }
  return { data, detail: msg || `HTTP ${txt ? 'fout' : 'lege response'}` };
}

/**
 * Hele Amsterdam-kalenderdag blokkeren (personal calendar / block-slots).
 * POST body: assignedUserId + locationId + tijden — geen calendarId (GHL: "not an event calendar").
 * calendarId blijft nodig voor idempotency-checks (blocked-slots / events scoped op kalender).
 */
export async function postFullDayBlockSlot(
  base,
  { locationId, calendarId, dateStr, title, apiKey, assignedUserId }
) {
  if (!apiKey) return { ok: false, error: 'Config ontbreekt (apiKey)' };
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return { ok: false, error: 'calendarId ontbreekt (zet GHL_CALENDAR_ID)' };
  const loc = locationId != null && String(locationId).trim() ? String(locationId).trim() : '';
  if (!loc) return { ok: false, error: 'locationId ontbreekt (zet GHL_LOCATION_ID)' };
  const uid = assignedUserId != null && String(assignedUserId).trim() ? String(assignedUserId).trim() : '';
  if (!uid) {
    return {
      ok: false,
      error:
        'assignedUserId ontbreekt: zet GHL_APPOINTMENT_ASSIGNED_USER_ID of GHL_BLOCK_SLOT_USER_ID in Vercel (teamkalenders).',
    };
  }

  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return { ok: false, error: 'Ongeldige datum' };
  const titleStr = (title && String(title).trim()) || 'Dag geblokkeerd';

  /**
   * Voorkom dubbele klik: blocked-slots met calendarId én met assignedUserId (personal blocks zonder event calendar).
   */
  if (process.env.GHL_BLOCK_SLOT_SKIP_IDEMPOTENCY_CHECK !== 'true') {
    const hasBlockedSlots = await dayHasBlockedSlotsOverlappingWorkHours(
      base,
      {
        locationId: loc,
        calendarId: cal,
        apiKey,
        calendarScopedOnly: false,
        assignedUserId: uid,
      },
      dateStr
    );
    const hasEventBlocks = await dayHasBlockLikeCalendarEventsOverlappingWorkHours(
      base,
      { locationId: loc, calendarId: cal, apiKey },
      dateStr
    );
    if (hasBlockedSlots || hasEventBlocks) {
      return {
        ok: true,
        status: 200,
        skipped: true,
        data: {},
        detail:
          'Deze kalender heeft al bloktijd (blocked-slots en/of agenda-events) die de werkdag raakt — geen nieuw blokslot geplaatst.',
      };
    }
  }

  /** Zelfde kalenderdag in Amsterdam: 00:00–23:59 met echte +01/+02 offset (geen UTC-Z → geen “2 dagen” in GHL). */
  const startTime = formatAmsterdamWallIso8601Offset(dateStr, 0, 0);
  const endTime = formatAmsterdamWallIso8601Offset(dateStr, 23, 59);
  if (!startTime || !endTime) return { ok: false, error: 'Ongeldige datum' };

  console.log('[postFullDayBlockSlot] uid:', uid, '| loc:', loc, '| cal (idempotency):', cal);
  console.log('[postFullDayBlockSlot] times before GHL POST (same calendar day):', startTime, '|', endTime);

  const body = {
    assignedUserId: uid,
    locationId: loc,
    startTime,
    endTime,
    title: titleStr,
  };

  const res = await fetchWithRetry(`${base}/calendars/events/block-slots`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Version: BLOCK_SLOT_POST_VERSION,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => '');
  const { data, detail } = parseGhlErrorBody(txt);
  return {
    ok: res.ok,
    status: res.status,
    data,
    detail,
    versionTried: BLOCK_SLOT_POST_VERSION,
    timeFormatTried: 'ams-same-day-00-00-to-23-59',
  };
}

/**
 * GHL block-slot op één Amsterdamse kalenderdag met wandtijd start/einde (zelfde POST als hele dag).
 */
export async function postAmsterdamWallBlockWindow(
  base,
  {
    locationId,
    calendarId,
    dateStr,
    title,
    apiKey,
    assignedUserId,
    startHour,
    startMinute,
    endHour,
    endMinute,
  }
) {
  if (!apiKey) return { ok: false, error: 'Config ontbreekt (apiKey)' };
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return { ok: false, error: 'calendarId ontbreekt (zet GHL_CALENDAR_ID)' };
  const loc = locationId != null && String(locationId).trim() ? String(locationId).trim() : '';
  if (!loc) return { ok: false, error: 'locationId ontbreekt (zet GHL_LOCATION_ID)' };
  const uid = assignedUserId != null && String(assignedUserId).trim() ? String(assignedUserId).trim() : '';
  if (!uid) {
    return {
      ok: false,
      error:
        'assignedUserId ontbreekt: zet GHL_APPOINTMENT_ASSIGNED_USER_ID of GHL_BLOCK_SLOT_USER_ID in Vercel (teamkalenders).',
    };
  }

  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return { ok: false, error: 'Ongeldige datum' };
  const titleStr = (title && String(title).trim()) || 'Dag geblokkeerd';

  const sh = Math.trunc(startHour);
  const sm = Math.trunc(startMinute);
  const eh = Math.trunc(endHour);
  const em = Math.trunc(endMinute);
  const rangeStartMs = amsterdamWallTimeToDate(dateStr, sh, sm)?.getTime();
  const rangeEndMs = amsterdamWallTimeToDate(dateStr, eh, em)?.getTime();
  if (rangeStartMs == null || rangeEndMs == null || rangeStartMs >= rangeEndMs) {
    return { ok: false, error: 'Ongeldig bloktijdvenster' };
  }

  if (process.env.GHL_BLOCK_SLOT_SKIP_IDEMPOTENCY_CHECK !== 'true') {
    const hasOverlap = await blockLikeOverlapsAmsterdamMsRange(
      base,
      { locationId: loc, calendarId: cal, apiKey, assignedUserId: uid },
      dateStr,
      rangeStartMs,
      rangeEndMs
    );
    if (hasOverlap) {
      return {
        ok: true,
        status: 200,
        skipped: true,
        data: {},
        detail:
          'Er is al bloktijd (blocked-slots en/of agenda-events) in dit tijdsvenster — geen nieuw blokslot geplaatst.',
      };
    }
  }

  const startTime = formatAmsterdamWallIso8601Offset(dateStr, sh, sm);
  const endTime = formatAmsterdamWallIso8601Offset(dateStr, eh, em);
  if (!startTime || !endTime) return { ok: false, error: 'Ongeldige datum' };

  console.log('[postAmsterdamWallBlockWindow] uid:', uid, '| loc:', loc, '| cal (idempotency):', cal);
  console.log('[postAmsterdamWallBlockWindow] times before GHL POST:', startTime, '|', endTime);

  const body = {
    assignedUserId: uid,
    locationId: loc,
    startTime,
    endTime,
    title: titleStr,
  };

  const res = await fetchWithRetry(`${base}/calendars/events/block-slots`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Version: BLOCK_SLOT_POST_VERSION,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => '');
  const { data, detail } = parseGhlErrorBody(txt);
  return {
    ok: res.ok,
    status: res.status,
    data,
    detail,
    versionTried: BLOCK_SLOT_POST_VERSION,
    timeFormatTried: 'ams-wall-window',
  };
}

/**
 * Verwijdert een GHL-blokslot of blok-achtig kalenderevent.
 * Probeert DELETE …/events/block-slots, …/blocked-slots, …/events, …/appointments.
 */
export async function deleteGhlCalendarBlock(base, apiKey, eventId, locationId = null) {
  const id = String(eventId || '').trim();
  if (!id || id.startsWith('hk_block_')) {
    return { ok: false, error: 'Ongeldig blok-event-id', status: 0 };
  }
  if (!apiKey) return { ok: false, error: 'API-key ontbreekt', status: 0 };

  const enc = encodeURIComponent(id);
  const loc = locationId != null && String(locationId).trim() ? String(locationId).trim() : '';
  const locQ = loc ? `?locationId=${encodeURIComponent(loc)}` : '';
  /** Block-slots: zowel …/events/block-slots als top-level …/blocked-slots (personal / API-varianten). */
  const urls = [
    `${base}/calendars/events/block-slots/${enc}${locQ}`,
    `${base}/calendars/blocked-slots/${enc}${locQ}`,
    `${base}/calendars/events/${enc}${locQ}`,
    `${base}/calendars/events/appointments/${enc}${locQ}`,
  ];
  let lastErr = '';
  for (const url of urls) {
    for (const version of API_VERSIONS) {
      const r = await fetchWithRetry(
        url,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${apiKey}`, Version: version },
        },
        0
      );
      if (r.ok || r.status === 404) {
        return { ok: true, status: r.status, via: url };
      }
      const t = await r.text().catch(() => '');
      lastErr = `${r.status} ${t}`.slice(0, 400);
    }
  }
  return { ok: false, error: lastErr || 'Verwijderen mislukt', status: 0 };
}

/**
 * Unieke blokslot-ids in een ms-bereik via GET /calendars/blocked-slots.
 * Met assignedUserId: userId-query (geen calendarId); zonder user: calendarId/legacy.
 */
export async function listBlockedSlotIdsForRange(
  base,
  { locationId, calendarId, apiKey, startMs, endMs, assignedUserId, overlapFilterMs = null }
) {
  if (!apiKey || !locationId || startMs == null || endMs == null) return [];
  const events = await fetchBlockedSlotsAsEvents(base, {
    locationId,
    calendarId,
    startMs,
    endMs,
    apiKey,
    calendarScopedOnly: false,
    assignedUserId,
  });
  const ids = new Set();
  for (const ev of events) {
    if (overlapFilterMs) {
      const os = overlapFilterMs.startMs;
      const oe = overlapFilterMs.endMs;
      if (os != null && oe != null && !blockedSlotEventOverlapsMs(ev, os, oe)) continue;
    }
    const id = String(ev?.id || '').trim();
    if (id && !id.startsWith('hk_block_')) ids.add(id);
  }
  return [...ids];
}

function blockLikeEventCanonicalId(e) {
  const raw =
    e?.id ??
    e?.eventId ??
    e?.appointmentId ??
    e?.appointment?.id ??
    e?.calendarEvent?.id;
  if (raw == null || raw === '') return '';
  return String(raw).trim();
}

/**
 * IDs om te DELETE: blocked-slots API + GET /calendars/events (blok-achtige events) in één ms-bereik.
 */
export async function listDeletableBlockIdsForMsRange(
  base,
  { locationId, calendarId, apiKey, startMs, endMs, assignedUserId, overlapFilterMs = null }
) {
  const uidPrimary =
    assignedUserId != null && String(assignedUserId).trim() ? String(assignedUserId).trim() : '';
  const uidsToScan = new Set([HK_DEFAULT_BLOCK_SLOT_USER_ID]);
  if (uidPrimary && uidPrimary !== HK_DEFAULT_BLOCK_SLOT_USER_ID) uidsToScan.add(uidPrimary);

  const ids = new Set();
  for (const uid of uidsToScan) {
    const chunk = await listBlockedSlotIdsForRange(base, {
      locationId,
      calendarId,
      apiKey,
      startMs,
      endMs,
      assignedUserId: uid,
      overlapFilterMs,
    });
    for (const id of chunk) ids.add(id);
  }
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (cal && locationId) {
    const url = `${base}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(cal)}&startTime=${startMs}&endTime=${endMs}`;
    for (const Version of ['2021-04-15', '2021-07-28']) {
      const res = await fetchWithRetry(
        url,
        {
          headers: { Authorization: `Bearer ${apiKey}`, Version },
        },
        0
      );
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      const events = [...(data?.events || [])];
      markBlockLikeOnCalendarEvents(events);
      for (const e of events) {
        if (!e._hkGhlBlockSlot) continue;
        if (overlapFilterMs) {
          const os = overlapFilterMs.startMs;
          const oe = overlapFilterMs.endMs;
          if (os != null && oe != null) {
            const s = ghlCalendarEventStartMs(e);
            let ee = ghlCalendarEventEndMs(e);
            if (!Number.isNaN(s) && !Number.isNaN(ee) && !(s < oe && ee > os)) continue;
          }
        }
        const cid = blockLikeEventCanonicalId(e);
        if (cid && !cid.startsWith('hk_block_')) ids.add(cid);
      }
    }
  }
  return [...ids].filter((id) => id && !id.startsWith('hk_block_'));
}

/**
 * Zelfde als listDeletableBlockIdsForMsRange voor één Amsterdam-kalenderdag.
 * Query-venster iets breder (±48h) zodat GHL-tijden net naast de ms-grens alsnog binnenkomen;
 * alleen slots die de echte kalenderdag raken tellen mee (overlapFilterMs).
 */
export async function listDeletableBlockIdsForAmsterdamDay(base, ctx, dateStr) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return [];
  const PAD_MS = 48 * 60 * 60 * 1000;
  return listDeletableBlockIdsForMsRange(base, {
    ...ctx,
    startMs: bounds.startMs - PAD_MS,
    endMs: bounds.endMs + PAD_MS,
    overlapFilterMs: bounds,
  });
}
