/**
 * Maximaal aantal agenda-items per dag waarvoor klanten via invite/bevestiging nog mogen boeken.
 * Handmatige afspraken in GHL tellen mee: zo kun jij zelf een 8e toevoegen als er al 7 staan.
 * Override: MAX_CUSTOMER_APPOINTMENTS_PER_DAY (bijv. 7).
 */
export function maxCustomerAppointmentsPerDay() {
  const n = parseInt(process.env.MAX_CUSTOMER_APPOINTMENTS_PER_DAY || '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** Aantal events op de gegeven kalender op die kalenderdag (zelfde query als send-booking-invite). */
export async function fetchCalendarEventCountForDay(dateStr, { base, locationId, calendarId, apiKey }) {
  const startMs = new Date(`${dateStr}T00:00:00+01:00`).getTime();
  const endMs = new Date(`${dateStr}T23:59:59+01:00`).getTime();
  const er = await fetch(
    `${base}/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${startMs}&endTime=${endMs}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' } }
  );
  if (!er.ok) return null;
  const data = await er.json().catch(() => ({}));
  const events = data?.events || [];
  return events.length;
}
