import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../lib/retry.js';

test('fetchWithRetry does not retry POST by default', async () => {
  let calls = 0;
  const orig = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return new Response('fail', { status: 503 });
  };
  try {
    const res = await fetchWithRetry('https://example.test', { method: 'POST' }, 3);
    assert.equal(res.status, 503);
    assert.equal(calls, 1);
  } finally {
    global.fetch = orig;
  }
});

test('fetchWithRetry retries retryable status', async () => {
  let calls = 0;
  const orig = global.fetch;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response('temp', { status: 503 });
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await fetchWithRetry(
      'https://example.test',
      { method: 'GET', _retryBaseDelayMs: 1, _retryJitterRatio: 0, _timeoutMs: 500 },
      3
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  } finally {
    global.fetch = orig;
  }
});
