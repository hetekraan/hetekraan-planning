/**
 * Server-side geblokkeerde datums (vakantie / vrij).
 *
 * Stel in Vercel → Settings → Environment Variables:
 *   BLOCKED_DATES = 2026-04-14,2026-04-21,2026-05-05
 *
 * Formaat: komma-gescheiden YYYY-MM-DD datums.
 * Wijzigingen zijn direct actief na de volgende deploy.
 */

/** Geeft de geblokkeerde datums terug als Set<string> (YYYY-MM-DD). */
export function getServerBlockedDates() {
  const raw = process.env.BLOCKED_DATES || '';
  const dates = new Set();
  for (const part of raw.split(',')) {
    const d = part.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
  }
  return dates;
}

/** Geeft true als de dag geblokkeerd is. */
export function isServerDateBlocked(dateStr) {
  return getServerBlockedDates().has(dateStr);
}

/** Maakt een schone lijst YYYY-MM-DD (uit array of komma-string). */
export function normalizeBlockedDateList(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const out = [];
  for (const x of arr) {
    const d = String(x).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.push(d);
  }
  return [...new Set(out)];
}
