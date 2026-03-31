/**
 * Zelfde absolute instant als Date, maar als ISO-string met Europe/Amsterdam-offset
 * (bijv. 2024-06-16T00:00:00+02:00). Sommige GHL-endpoints geven 422 op puur UTC-Z.
 */
export function formatAmsterdamOffsetIso(date) {
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
  const offset = normalizeGmtOffsetLabel(tzRaw);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

function normalizeGmtOffsetLabel(tzRaw) {
  const m = String(tzRaw).match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '+00:00';
  const sign = m[1];
  const hh = m[2].padStart(2, '0');
  const mm = (m[3] || '00').padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}
