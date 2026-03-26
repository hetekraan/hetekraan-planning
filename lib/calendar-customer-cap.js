import { amsterdamCalendarDayBoundsMs } from './amsterdam-calendar-day.js';

/**
 * Maximaal aantal agenda-items per dag waarvoor klanten via invite/bevestiging nog mogen boeken.
 * Standaard 7 (= max 4 ochtend + max 3 middag voor klanten); jij kunt in GHL nog handmatig bijboeken.
 * Override: MAX_CUSTOMER_APPOINTMENTS_PER_DAY (bijv. 7).
 */
export function maxCustomerAppointmentsPerDay() {
  const n = parseInt(process.env.MAX_CUSTOMER_APPOINTMENTS_PER_DAY || '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** Aantal events op de gegeven kalender op die kalenderdag (zelfde query als send-booking-invite). */
export async function fetchCalendarEventCountForDay(dateStr, { base, locationId, calendarId, apiKey }) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return null;
  const { startMs, endMs } = bounds;
  const er = await fetch(
    `${base}/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${startMs}&endTime=${endMs}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' } }
  );
  if (!er.ok) return null;
  const data = await er.json().catch(() => ({}));
  const events = data?.events || [];
  return events.length;
}

/** Alle kalender-events op die kalenderdag (zelfde query als dag-telling). */
export async function fetchCalendarEventsForDay(dateStr, { base, locationId, calendarId, apiKey }) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return null;
  const { startMs, endMs } = bounds;
  const er = await fetch(
    `${base}/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${startMs}&endTime=${endMs}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' } }
  );
  if (!er.ok) return null;
  const data = await er.json().catch(() => ({}));
  return data?.events || [];
}
