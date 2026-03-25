/**
 * Europe/Amsterdam wandtijd op dateStr (YYYY-MM-DD) → UTC Date.
 * Voorkomt 1-uur verschil door vaste +01:00 in de zomer (CEST).
 */
export function amsterdamWallTimeToDate(dateStr, hour, minute) {
  const pad = (n) => String(Math.trunc(n)).padStart(2, '0');
  const h = Math.trunc(hour);
  const m = Math.trunc(minute);
  const wantDay = dateStr;

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
    if (day === wantDay && hGot === h && mGot === m) return d;
  }

  return new Date(`${dateStr}T${pad(h)}:${pad(m)}:00+01:00`);
}
