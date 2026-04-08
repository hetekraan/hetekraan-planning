const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const buckets = new Map();

export function applySecurityHeaders(res) {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cache-Control', 'no-store');
  } catch {}
}

export function enforceSimpleRateLimit(req, res, keyPrefix = 'api') {
  const key = `${keyPrefix}:${clientIp(req)}`;
  const now = Date.now();
  const entry = buckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  buckets.set(key, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    try {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    } catch {}
    return false;
  }
  return true;
}

function clientIp(req) {
  const xfwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xfwd || String(req?.socket?.remoteAddress || 'unknown');
}
