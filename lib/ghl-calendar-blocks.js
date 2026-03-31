/**
 * GHL “block slots” — officiële manier om tijd te blokkeren (los van klantafspraken).
 * Docs o.a.: POST …/calendars/events/block-slots, GET …/calendars/blocked-slots
 */

import { amsterdamCalendarDayBoundsMs } from './amsterdam-calendar-day.js';
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { fetchWithRetry } from './retry.js';

const HDR = { Version: '2021-04-15' };

/**
 * Haalt geblokkeerde slots op en zet ze om naar event-achtige objecten voor het dashboard.
 */
export async function fetchBlockedSlotsAsEvents(base, { locationId, calendarId, startMs, endMs, apiKey }) {
  if (!apiKey || !locationId || startMs == null || endMs == null) return [];
  let url = `${base}/calendars/blocked-slots?locationId=${encodeURIComponent(locationId)}&startTime=${startMs}&endTime=${endMs}`;
  if (calendarId) url += `&calendarId=${encodeURIComponent(calendarId)}`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${apiKey}`, ...HDR },
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

/**
 * Hele Amsterdam-kalenderdag blokkeren op de gegeven kalender.
 * Optioneel: GHL_BLOCK_SLOT_USER_ID = assignedUserId (bijv. monteur Jerry).
 */
export async function postFullDayBlockSlot(base, { locationId, calendarId, dateStr, title, apiKey, assignedUserId }) {
  if (!apiKey || !locationId) return { ok: false, error: 'Config ontbreekt' };
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return { ok: false, error: 'Ongeldige datum' };
  const startD = amsterdamWallTimeToDate(dateStr, 0, 0);
  if (!startD) return { ok: false, error: 'Ongeldige datum' };
  const body = {
    locationId,
    startTime: startD.toISOString(),
    endTime: new Date(bounds.endMs).toISOString(),
    title: (title && String(title).trim()) || 'Dag geblokkeerd',
  };
  if (calendarId) body.calendarId = calendarId;
  if (assignedUserId) body.assignedUserId = assignedUserId;

  const res = await fetchWithRetry(`${base}/calendars/events/block-slots`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...HDR,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => '');
  let data = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = { raw: txt.slice(0, 500) };
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    detail: typeof data?.message === 'string' ? data.message : txt.slice(0, 400),
  };
}
