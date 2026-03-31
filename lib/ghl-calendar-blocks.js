/**
 * GHL “block slots” — officiële manier om tijd te blokkeren (los van klantafspraken).
 * POST …/calendars/events/block-slots, GET …/calendars/blocked-slots
 */

import { amsterdamCalendarDayBoundsMs } from './amsterdam-calendar-day.js';
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { fetchWithRetry } from './retry.js';

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

  const body = {
    locationId,
    calendarId: cal,
    startTime: startD.toISOString(),
    endTime: new Date(bounds.endMs).toISOString(),
    title: titleStr,
    assignedUserId: uid,
  };

  let last = { ok: false, status: 0, data: {}, detail: 'Geen poging uitgevoerd' };

  for (const version of API_VERSIONS) {
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
    last = { ok: res.ok, status: res.status, data, detail, versionTried: version };
    if (res.ok) return last;
    if (res.status === 401 || res.status === 403) return last;
  }
  return last;
}
