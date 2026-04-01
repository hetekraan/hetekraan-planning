/**
 * GHL “block slots” — officiële manier om tijd te blokkeren (los van klantafspraken).
 * POST …/calendars/events/block-slots, GET …/calendars/blocked-slots
 */

import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  hourInAmsterdam,
} from './amsterdam-calendar-day.js';
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { fetchWithRetry } from './retry.js';

/** Zelfde instant als ISO met Europe/Amsterdam-offset (sommige GHL-validators wijzen UTC-Z af). */
function formatAmsterdamOffsetIso(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = f.formatToParts(date);
  const p = {};
  for (const x of parts) {
    if (x.type !== 'literal') p[x.type] = x.value;
  }
  const tzRaw = p.timeZoneName || 'GMT+00:00';
  const m = String(tzRaw).match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  const offset = `${m[1]}${m[2].padStart(2, '0')}:${(m[3] || '00').padStart(2, '0')}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

/** Block-slots: 2021-07-28 eerst (strengere ISO/slot-validatie sluit vaak beter aan op huidige GHL). */
const API_VERSIONS = ['2021-07-28', '2021-04-15'];

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
 * Probeert meerdere API-versies en met/zonder calendarId — responsevorm verschilt per omgeving.
 */
export async function fetchBlockedSlotsAsEvents(base, { locationId, calendarId, startMs, endMs, apiKey }) {
  if (!apiKey || !locationId || startMs == null || endMs == null) return [];
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  const versions = ['2021-04-15', '2021-07-28'];
  const byId = new Map();

  const runFetch = async (version, includeCal) => {
    let url = `${base}/calendars/blocked-slots?locationId=${encodeURIComponent(locationId)}&startTime=${startMs}&endTime=${endMs}`;
    if (includeCal && cal) url += `&calendarId=${encodeURIComponent(cal)}`;
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
      await runFetch(version, true);
      if (cal) await runFetch(version, false);
    }
  } catch {
    return Array.from(byId.values());
  }
  return Array.from(byId.values());
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

function ghlCalendarEventStartMs(e) {
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

function ghlCalendarEventEndMs(e) {
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
 * Minstens één GHL-blokslot raakt werktijd 09:00–17:00 Amsterdam → geen klant-slots die dag.
 */
export async function dayHasBlockedSlotsOverlappingWorkHours(base, { locationId, calendarId, apiKey }, dateStr) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds || !apiKey || !locationId) return false;
  const workStart = amsterdamWallTimeToDate(dateStr, 9, 0)?.getTime();
  const workEnd = amsterdamWallTimeToDate(dateStr, 17, 0)?.getTime();
  if (workStart == null || workEnd == null) return false;
  const slots = await fetchBlockedSlotsAsEvents(base, {
    locationId,
    calendarId,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    apiKey,
  });
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
 * Dag skippen bij tijdvoorstellen / boeken: blocked-slots API + block-achtige events uit calendars/events.
 */
export async function dayHasCustomerBlockingOverlap(base, { locationId, calendarId, apiKey }, dateStr) {
  if (await dayHasBlockedSlotsOverlappingWorkHours(base, { locationId, calendarId, apiKey }, dateStr)) {
    return true;
  }
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds || !apiKey || !locationId) return false;
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return false;
  const url = `${base}/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(cal)}&startTime=${bounds.startMs}&endTime=${bounds.endMs}`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  let events = [...(data?.events || [])];
  const blockedMerged = await fetchBlockedSlotsAsEvents(base, {
    locationId,
    calendarId,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    apiKey,
  });
  events = events.concat(blockedMerged);
  markBlockLikeOnCalendarEvents(events);
  const workStart = amsterdamWallTimeToDate(dateStr, 9, 0)?.getTime();
  const workEnd = amsterdamWallTimeToDate(dateStr, 17, 0)?.getTime();
  if (workStart == null || workEnd == null) return false;
  for (const e of events) {
    if (!e._hkGhlBlockSlot) continue;
    const s = ghlCalendarEventStartMs(e);
    let eMs = ghlCalendarEventEndMs(e);
    if (Number.isNaN(s)) return true;
    if (Number.isNaN(eMs)) eMs = bounds.endMs;
    if (s < workEnd && eMs > workStart) return true;
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
      if (s < workEnd && eMs > workStart) return true;
    }
  }
  return false;
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
  return hourInAmsterdam(raw) < 13;
}

export function suggestEventInAfternoonHalf(e) {
  const raw = ghlEventStartRaw(e);
  if (raw == null) return false;
  return hourInAmsterdam(raw) >= 13;
}

function normalizeBlockedToEvent(s) {
  if (!s || typeof s !== 'object') return null;
  const id = s.id ?? s.eventId ?? s.blockedSlotId ?? s.blockId ?? s.slotId;
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
 * Hele Amsterdam-kalenderdag blokkeren. Teamkalenders vereisen assignedUserId (Vercel: GHL_BLOCK_SLOT_USER_ID of GHL_APPOINTMENT_ASSIGNED_USER_ID).
 */
export async function postFullDayBlockSlot(
  base,
  { locationId, calendarId, dateStr, title, apiKey, assignedUserId }
) {
  if (!apiKey || !locationId) return { ok: false, error: 'Config ontbreekt' };
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return { ok: false, error: 'calendarId ontbreekt (zet GHL_CALENDAR_ID)' };
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
  const startD = amsterdamWallTimeToDate(dateStr, 0, 0);
  if (!startD) return { ok: false, error: 'Ongeldige datum' };
  const titleStr = (title && String(title).trim()) || 'Dag geblokkeerd';

  /** GHL 422: "startTime/endTime must be a valid ISO 8601 date string" — gebruik UTC-Z (toISOString), geen ms-strings. */
  const startIsoZ = startD.toISOString();
  const endInclusiveZ = new Date(bounds.endMs).toISOString();
  const nextDayStr = addAmsterdamCalendarDays(dateStr, 1);
  const endNextMid = nextDayStr ? amsterdamWallTimeToDate(nextDayStr, 0, 0) : null;
  const endExclusiveZ = endNextMid ? endNextMid.toISOString() : null;
  const endD = new Date(bounds.endMs);
  const startAms = formatAmsterdamOffsetIso(startD);
  const endAms = formatAmsterdamOffsetIso(endD);
  const endNextAms = endNextMid ? formatAmsterdamOffsetIso(endNextMid) : null;

  const shapes = [];
  /** Hele kalenderdag als [00:00, volgende 00:00) Amsterdam — meest stabiele slot-range voor GHL. */
  if (endExclusiveZ) {
    shapes.push({
      label: 'iso-z-exclusive-next-mid',
      build: (includeCal) => {
        const b = {
          locationId,
          startTime: startIsoZ,
          endTime: endExclusiveZ,
          title: titleStr,
          assignedUserId: uid,
        };
        if (includeCal) b.calendarId = cal;
        return b;
      },
    });
  }
  shapes.push({
    label: 'iso-z-inclusive-day-end',
    build: (includeCal) => {
      const b = {
        locationId,
        startTime: startIsoZ,
        endTime: endInclusiveZ,
        title: titleStr,
        assignedUserId: uid,
      };
      if (includeCal) b.calendarId = cal;
      return b;
    },
  });
  if (startAms && endNextAms) {
    shapes.push({
      label: 'ams-offset-next-midnight',
      build: (includeCal) => {
        const b = {
          locationId,
          startTime: startAms,
          endTime: endNextAms,
          title: titleStr,
          assignedUserId: uid,
        };
        if (includeCal) b.calendarId = cal;
        return b;
      },
    });
  }
  if (startAms && endAms) {
    shapes.push({
      label: 'ams-offset-same-day',
      build: (includeCal) => {
        const b = {
          locationId,
          startTime: startAms,
          endTime: endAms,
          title: titleStr,
          assignedUserId: uid,
        };
        if (includeCal) b.calendarId = cal;
        return b;
      },
    });
  }

  let last = { ok: false, status: 0, data: {}, detail: 'Geen poging uitgevoerd' };

  /**
   * Standaard ALLEEN met calendarId — zo komt het blok op kalender GHL_CALENDAR_ID (bijv. Planning Jerry).
   * Zonder calendarId kan GHL een user-only blok maken (Calendar leeg in UI; niet zichtbaar op teamkalender).
   * Legacy: zet GHL_BLOCK_SLOT_ALLOW_OMIT_CALENDAR_ID=true om weer [met, zonder] te proberen.
   */
  const allowOmitCalendarId = process.env.GHL_BLOCK_SLOT_ALLOW_OMIT_CALENDAR_ID === 'true';
  const phases = allowOmitCalendarId ? [true, false] : [true];

  for (const includeCal of phases) {
    for (const { label, build } of shapes) {
      for (const version of API_VERSIONS) {
        const body = build(includeCal);
        const res = await fetchWithRetry(`${base}/calendars/events/block-slots`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Version: version,
          },
          body: JSON.stringify(body),
        });
        const txt = await res.text().catch(() => '');
        const { data, detail } = parseGhlErrorBody(txt);
        last = {
          ok: res.ok,
          status: res.status,
          data,
          detail,
          versionTried: version,
          timeFormatTried: label,
          calendarIdOmitted: !includeCal,
        };
        if (res.ok) return last;
        if (res.status === 401 || res.status === 403) return last;
      }
    }
  }
  return last;
}

/**
 * Verwijdert een GHL-blokslot of blok-achtig kalenderevent.
 * Probeert o.a. DELETE …/block-slots/:id, daarna …/calendars/events/:id (zelfde volgorde als dashboard-delete).
 */
export async function deleteGhlCalendarBlock(base, apiKey, eventId) {
  const id = String(eventId || '').trim();
  if (!id || id.startsWith('hk_block_')) {
    return { ok: false, error: 'Ongeldig blok-event-id', status: 0 };
  }
  if (!apiKey) return { ok: false, error: 'API-key ontbreekt', status: 0 };

  const enc = encodeURIComponent(id);
  const urls = [
    `${base}/calendars/events/block-slots/${enc}`,
    `${base}/calendars/events/${enc}`,
    `${base}/calendars/events/appointments/${enc}`,
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
