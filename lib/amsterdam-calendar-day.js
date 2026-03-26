/**
 * Kalenderdagen in Europe/Amsterdam (Vercel draait in UTC — geen setHours(0) / toISOString date).
 */
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';

export function formatYyyyMmDdInAmsterdam(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !day) return null;
  return `${y}-${m}-${day}`;
}

/** Start (00:00) en eind (23:59:59.999) van die dag in Amsterdam → UTC-ms voor GHL. */
export function amsterdamCalendarDayBoundsMs(dateStr) {
  const startD = amsterdamWallTimeToDate(dateStr, 0, 0);
  const endD = amsterdamWallTimeToDate(dateStr, 23, 59);
  if (!startD || !endD) return null;
  return { startMs: startD.getTime(), endMs: endD.getTime() + 60_000 - 1 };
}

/** Volgende/vorige kalenderdag in Amsterdam (+/- delta dagen). */
export function addAmsterdamCalendarDays(dateStr, delta) {
  const b = amsterdamCalendarDayBoundsMs(dateStr);
  if (!b) return null;
  const t = b.startMs + Number(delta) * 86400000;
  return formatYyyyMmDdInAmsterdam(new Date(t));
}

/** 0 = zondag … 6 = zaterdag (Europe/Amsterdam). */
export function amsterdamWeekdaySun0(dateStr) {
  const b = amsterdamCalendarDayBoundsMs(dateStr);
  if (!b) return null;
  const w = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
  }).format(new Date(b.startMs));
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? null;
}

/** Uur 0–23 van dit moment in Amsterdam (voor ochtend/middag-split). */
export function hourInAmsterdam(isoOrMs) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: 'numeric',
    hour12: false,
  }).format(new Date(isoOrMs));
  return parseInt(h, 10);
}

/** Decimaal uur in Amsterdam (bijv. 9.5 = 09:30), voor slot-overlap met GHL-events. */
export function hourDecimalInAmsterdam(isoOrMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(isoOrMs));
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return h + m / 60;
}
