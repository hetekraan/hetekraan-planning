// Exponential backoff retry wrapper met jitter, Retry-After en per-attempt timeout.
// Standaard retries op 429/500/502/503/504 + netwerkfouten.
// POST wordt alleen geretried als caller expliciet _allowPostRetry=true zet.

const DEFAULT_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const method = (options.method || 'GET').toUpperCase();
  const isPost = method === 'POST';
  const reqId = String(options._requestId || '').trim();
  const baseDelayMs =
    Number.isFinite(options._retryBaseDelayMs) && options._retryBaseDelayMs > 0
      ? Math.round(options._retryBaseDelayMs)
      : 500;
  const jitterRatio =
    Number.isFinite(options._retryJitterRatio) && options._retryJitterRatio >= 0
      ? Math.min(1, options._retryJitterRatio)
      : 0.25;
  const timeoutMs =
    Number.isFinite(options._timeoutMs) && options._timeoutMs > 0
      ? Math.round(options._timeoutMs)
      : 15000;
  const retryableStatus = new Set(
    Array.isArray(options._retryOnStatus) && options._retryOnStatus.length
      ? options._retryOnStatus
      : [...DEFAULT_RETRYABLE_STATUS]
  );

  if (isPost && maxRetries > 0 && !options._allowPostRetry) {
    maxRetries = 0;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let controller = null;
    let timer = null;
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const res = await fetch(url, {
        ...options,
        signal: controller ? controller.signal : options.signal,
      });
      if (timer) clearTimeout(timer);

      if (res.ok || (res.status >= 400 && res.status < 500 && !retryableStatus.has(res.status))) {
        return res;
      }
      const shouldRetry = retryableStatus.has(res.status) && attempt < maxRetries;
      if (!shouldRetry) return res;

      const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
      const delay = retryAfterMs ?? backoffWithJitter(baseDelayMs, attempt, jitterRatio);
      console.warn(
        `[retry] status=${res.status} attempt=${attempt + 1}/${maxRetries + 1} delay_ms=${delay}${reqId ? ` request_id=${reqId}` : ''}`
      );
      await sleep(delay);
    } catch (err) {
      if (timer) clearTimeout(timer);
      const isAbort = err?.name === 'AbortError';
      if (attempt >= maxRetries) throw err;
      const delay = backoffWithJitter(baseDelayMs, attempt, jitterRatio);
      console.warn(
        `[retry] network_error=${isAbort ? 'timeout' : 'true'} attempt=${attempt + 1}/${maxRetries + 1} delay_ms=${delay}${reqId ? ` request_id=${reqId}` : ''}: ${err?.message || err}`
      );
      await sleep(delay);
    }
  }
}

function backoffWithJitter(baseDelayMs, attempt, jitterRatio) {
  const raw = baseDelayMs * Math.pow(2, attempt);
  if (jitterRatio <= 0) return Math.round(raw);
  const span = raw * jitterRatio;
  const min = Math.max(0, raw - span);
  const max = raw + span;
  return Math.round(min + Math.random() * (max - min));
}

function parseRetryAfterMs(header) {
  if (!header) return null;
  const s = String(header).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10) * 1000);
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, ts - Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
