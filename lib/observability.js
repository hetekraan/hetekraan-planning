import { randomUUID } from 'node:crypto';

export function getOrCreateRequestId(req, res) {
  const fromHeader = String(req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'] || '').trim();
  const id = fromHeader || randomUUID();
  try {
    if (res?.setHeader) res.setHeader('X-Request-Id', id);
  } catch {}
  return id;
}

export function logEvent(event, payload = {}, level = 'info') {
  const row = {
    ts: new Date().toISOString(),
    level,
    event,
    ...payload,
  };
  const line = JSON.stringify(row);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function nowMs() {
  return Date.now();
}

export function durationMs(t0) {
  return Math.max(0, Date.now() - (Number(t0) || Date.now()));
}
