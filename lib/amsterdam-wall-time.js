/**
 * Europe/Amsterdam wandtijd op dateStr (YYYY-MM-DD) → UTC Date.
 * DST-bewust: zoekt de exacte UTC-milliseconde die in Amsterdam het gewenste
 * uur:minuut op die kalenderdag weergeeft.
 * Fallback: als de loop geen match vindt (zou niet mogen), schat de UTC-offset
 * op basis van de dag zelf (niet vast +01:00).
 */
export function amsterdamWallTimeToDate(dateStr, hour, minute) {
  const pad = (n) => String(Math.trunc(n)).padStart(2, '0');
  const h = Math.trunc(hour);
  const m = Math.trunc(minute);

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const base = Date.parse(`${dateStr}T12:00:00.000Z`);
  if (Number.isNaN(base)) return null;

  const start = base - 14 * 3600000;
  const end = base + 14 * 3600000;

  for (let ms = start; ms <= end; ms += 60000) {
    const d = new Date(ms);
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
    );
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const hGot = parseInt(parts.hour, 10);
    const mGot = parseInt(parts.minute, 10);
    if (day === dateStr && hGot === h && mGot === m) return d;
  }

  // Nood-fallback: bepaal UTC-offset door middernacht van die dag te zoeken.
  // Dit is DST-bewust (niet vast +01:00) en geeft altijd een redelijk resultaat.
  for (let ms = start; ms <= end; ms += 60000) {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
    );
    if (`${parts.year}-${parts.month}-${parts.day}` === dateStr &&
        parseInt(parts.hour, 10) === 0 && parseInt(parts.minute, 10) === 0) {
      return new Date(ms + (h * 60 + m) * 60000);
    }
  }

  return null;
}

/**
 * ISO 8601 met numerieke offset voor wandtijd op dateStr (YYYY-MM-DD) in Europe/Amsterdam.
 * De datum in de string is altijd dateStr — geschikt voor GHL block-slots (één kalenderdag).
 */
export function formatAmsterdamWallIso8601Offset(dateStr, hour, minute) {
  const d = amsterdamWallTimeToDate(dateStr, hour, minute);
  if (!d) return null;
  const h = Math.trunc(hour);
  const mi = Math.trunc(minute);
  const pad = (n) => String(Math.trunc(n)).padStart(2, '0');
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const tzName = tzParts.find((p) => p.type === 'timeZoneName')?.value || '';
  /** o.a. "GMT+2", "GMT+02:00", "UTC+02:00" */
  const m = String(tzName).match(/(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/i);
  let suffix = '+01:00';
  if (m) {
    const sign = m[1];
    const hh = String(parseInt(m[2], 10)).padStart(2, '0');
    const mm = String(parseInt(m[3] ?? '0', 10)).padStart(2, '0');
    suffix = `${sign}${hh}:${mm}`;
  }
  return `${dateStr}T${pad(h)}:${pad(mi)}:00${suffix}`;
}
