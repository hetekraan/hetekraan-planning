/**
 * ETA-klok helpers (Europe/Amsterdam) voor onderweg-flow.
 */

export function nowMinutesInAmsterdam(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

export function minutesToTimeStr(totalMinutes) {
  const m = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseTimeToMinutes(value) {
  const s = String(value || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

/** Absolute verschil in minuten tussen twee HH:MM strings (zelfde dag). */
export function etaDiffMinutes(a, b) {
  const ma = parseTimeToMinutes(a);
  const mb = parseTimeToMinutes(b);
  if (ma == null || mb == null) return Infinity;
  return Math.abs(ma - mb);
}

/** Huidige tijd + reistijd → HH:MM (afgerond op hele minuten). */
export function computeEtaFromTravelMinutes(travelMinutes, nowMinutes = nowMinutesInAmsterdam()) {
  const travel = Math.max(0, Math.ceil(Number(travelMinutes) || 0));
  return minutesToTimeStr(nowMinutes + travel);
}
