/**
 * GHL “block slots” — officiële manier om tijd te blokkeren (los van klantafspraken).
 * Docs o.a.: POST …/calendars/events/block-slots, GET …/calendars/blocked-slots
 */

import { addAmsterdamCalendarDays, amsterdamCalendarDayBoundsMs } from './amsterdam-calendar-day.js';
import { formatAmsterdamOffsetIso } from './format-amsterdam-offset-iso.js';
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { fetchWithRetry } from './retry.js';

/** Zelfde volgorde als confirm-booking: nieuwere API eerst. */
const API_VERSIONS = ['2021-07-28', '2021-04-15'];

/**
 * Haalt geblokkeerde slots op en zet ze om naar event-achtige objecten voor het dashboard.
 */
export async function fetchBlockedSlotsAsEvents(base, { locationId, calendarId, startMs, endMs, apiKey }) {
  if (!apiKey || !locationId || startMs == null || endMs == null) return [];
  let url = `${base}/calendars/blocked-slots?locationId=${encodeURIComponent(locationId)}&startTime=${startMs}&endTime=${endMs}`;
  if (calendarId) url += `&calendarId=${encodeURIComponent(calendarId)}`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const raw =
      data.blockedSlots ||
      data.blockSlots ||
      data.events ||
      data.data ||
      (Array.isArray(data) ? data : null);
    const list = Array.isArray(raw) ? raw : [];
    return list.map(normalizeBlockedToEvent).filter(Boolean);
  } catch {
    return [];
  }
}

function blockStartMs(b) {
  const s = b.startTime ?? b.start;
  if (s == null) return NaN;
  if (typeof s === 'number') return s < 1e12 ? Math.round(s * 1000) : s;
  const t = Date.parse(String(s));
  return Number.isNaN(t) ? NaN : t;
}

function blockEndMs(b) {
  const e = b.endTime ?? b.end;
  if (e == null) return NaN;
  if (typeof e === 'number') return e < 1e12 ? Math.round(e * 1000) : e;
  const t = Date.parse(String(e));
  return Number.isNaN(t) ? NaN : t;
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
    if (Number.isNaN(s)) continue;
    if (Number.isNaN(e)) e = bounds.endMs;
    if (s < workEnd && e > workStart) return true;
  }
  return false;
}

function normalizeBlockedToEvent(s) {
  if (!s || typeof s !== 'object') return null;
  const id = s.id ?? s.eventId ?? s.blockedSlotId ?? s.blockId;
  const start = s.startTime ?? s.start ?? s.from;
  const end = s.endTime ?? s.end ?? s.to ?? start;
  if (start == null && id == null) return null;
  return {
    id: id != null ? String(id) : `hk_block_${String(start)}`,
    title: s.title || s.name || 'Agenda geblokkeerd',
    startTime: start,
    endTime: end,
    contactId: undefined,
    _hkGhlBlockSlot: true,
  };
}

function parseGhlErrorBody(txt) {
  let data = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = { raw: String(txt || '').slice(0, 500) };
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
  return { data, detail: msg || `HTTP ${txt ? 'fout' : 'lege response'}` };
}

/**
 * Hele Amsterdam-kalenderdag blokkeren op de gegeven kalender.
 * Probeert meerdere API-versies en assignedUserId-varianten (zoals appointments in confirm-booking).
 * Opties in env: GHL_BLOCK_SLOT_USER_ID, anders GHL_APPOINTMENT_ASSIGNED_USER_ID als fallback.
 */
export async function postFullDayBlockSlot(
  base,
  { locationId, calendarId, dateStr, title, apiKey, blockSlotUserId, appointmentUserId }
) {
  if (!apiKey || !locationId) return { ok: false, error: 'Config ontbreekt' };
  const cal = calendarId != null && String(calendarId).trim() ? String(calendarId).trim() : '';
  if (!cal) return { ok: false, error: 'calendarId ontbreekt (zet GHL_CALENDAR_ID)' };

  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return { ok: false, error: 'Ongeldige datum' };
  const startD = amsterdamWallTimeToDate(dateStr, 0, 0);
  if (!startD) return { ok: false, error: 'Ongeldige datum' };
  const startIso = startD.toISOString();
  const endD = new Date(bounds.endMs);
  const endIso = endD.toISOString();
  const endIsoNoMs = endIso.replace(/\.\d{3}Z$/, 'Z');
  const startIsoNoMs = startIso.replace(/\.\d{3}Z$/, 'Z');
  const titleStr = (title && String(title).trim()) || 'Dag geblokkeerd';

  const nextDayStr = addAmsterdamCalendarDays(dateStr, 1);
  const endNextMidnight = nextDayStr ? amsterdamWallTimeToDate(nextDayStr, 0, 0) : null;
  const startAms = formatAmsterdamOffsetIso(startD);
  const endAms = formatAmsterdamOffsetIso(endD);
  const endNextAms = endNextMidnight ? formatAmsterdamOffsetIso(endNextMidnight) : null;

  const bu = (blockSlotUserId && String(blockSlotUserId).trim()) || '';
  const au = (appointmentUserId && String(appointmentUserId).trim()) || '';
  /**
   * Zelfde idee als confirm-booking: bij teamkalenders eerst mét user, dan zonder.
   * Alleen-zonder eerst proberen geeft daar vaak 400.
   */
  const userVariants = [];
  if (bu) userVariants.push(bu);
  if (au && au !== bu) userVariants.push(au);
  userVariants.push(undefined);

  /** Volgorde: Amsterdam-offset en “tot volgende middernacht” lossen vaak 422 op. */
  const timeShapes = [];
  if (startAms && endAms) {
    timeShapes.push({ label: 'ams-offset', startTime: startAms, endTime: endAms });
  }
  if (startAms && endNextAms) {
    timeShapes.push({
      label: 'ams-offset-next-midnight',
      startTime: startAms,
      endTime: endNextAms,
    });
  }
  const secStart = Math.floor(bounds.startMs / 1000);
  const secEnd = Math.floor(bounds.endMs / 1000);
  timeShapes.push(
    { label: 'iso', startTime: startIso, endTime: endIso },
    { label: 'iso-no-ms', startTime: startIsoNoMs, endTime: endIsoNoMs },
    /** Docs: startTime/endTime zijn String — pure numbers geven vaak 422. */
    { label: 'ms-str', startTime: String(bounds.startMs), endTime: String(bounds.endMs) },
    { label: 'sec-str', startTime: String(secStart), endTime: String(secEnd) }
  );

  let last = { ok: false, status: 0, data: {}, detail: 'Geen poging uitgevoerd' };

  /** Eerst mét calendarId; daarna (standaard) zonder — sommige GHL-setups geven 422 op “verkeerd” id-type. Uitzetten: GHL_BLOCK_SLOT_SKIP_NO_CALENDAR_ID=true */
  const skipOmitCalendar = process.env.GHL_BLOCK_SLOT_SKIP_NO_CALENDAR_ID === 'true';
  const phases = [true];
  if (!skipOmitCalendar) phases.push(false);

  for (const includeCalendarId of phases) {
    for (const version of API_VERSIONS) {
      for (const { label: timeLabel, startTime, endTime } of timeShapes) {
        for (const assignedUserId of userVariants) {
          const body = {
            locationId,
            startTime,
            endTime,
            title: titleStr,
          };
          if (includeCalendarId) body.calendarId = cal;
          if (assignedUserId) body.assignedUserId = String(assignedUserId);

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
            timeFormatTried: timeLabel,
            calendarIdOmitted: !includeCalendarId,
          };
          if (res.ok) return last;
          if (res.status === 401 || res.status === 403) return last;
        }
      }
    }
  }
  return last;
}
