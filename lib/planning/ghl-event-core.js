/**
 * GHL kalender-event: canonieke id + start/eind in ms.
 * Gedeeld door api/ghl.js en lib/planning/appointment.js.
 */

import { formatYyyyMmDdInAmsterdam } from '../amsterdam-calendar-day.js';

export function canonicalGhlEventId(e) {
  const raw =
    e?.id ??
    e?.eventId ??
    e?.appointmentId ??
    e?.appointment?.id ??
    e?.calendarEvent?.id;
  if (raw == null || raw === '') return '';
  return String(raw);
}

export function eventStartMsGhl(e) {
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

export function eventEndMsGhl(e) {
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

/** GHL kalender-event → YYYY-MM-DD startdag in Europe/Amsterdam (of null). */
export function getEventStartDayAmsterdam(e) {
  const ms = eventStartMsGhl(e);
  if (Number.isNaN(ms)) return null;
  return formatYyyyMmDdInAmsterdam(new Date(ms));
}
