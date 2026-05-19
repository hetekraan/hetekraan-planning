import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_BOOKING_TAG,
  pulsePendingBookingTag,
  pulseContactTag,
  removePendingBookingTag,
} from '../lib/ghl-tag.js';

function tagCallsFromFetch(fetchFn) {
  const calls = [];
  const wrapped = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (String(url).includes('/tags')) {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, tags: body.tags });
    }
    return {
      ok: true,
      status: method === 'DELETE' ? 200 : 201,
      text: async () => JSON.stringify({ ok: true }),
    };
  };
  return { calls, fetchFn: wrapped };
}

test('invite: pulsePendingBookingTag adds niet-bevestigd (delete then post)', async () => {
  const { calls, fetchFn } = tagCallsFromFetch();
  const ok = await pulsePendingBookingTag('c-invite', '[test]', null, {
    apiKey: 'test-key',
    fetchFn,
    delayMs: 0,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { method: 'DELETE', tags: [PENDING_BOOKING_TAG] });
  assert.deepEqual(calls[1], { method: 'POST', tags: [PENDING_BOOKING_TAG] });
});

test('second invite same contact: pulse deletes and re-adds niet-bevestigd', async () => {
  const { calls, fetchFn } = tagCallsFromFetch();
  const opts = { apiKey: 'test-key', fetchFn, delayMs: 0 };
  assert.equal(await pulsePendingBookingTag('c-repeat', '[test]', null, opts), true);
  assert.equal(await pulsePendingBookingTag('c-repeat', '[test]', null, opts), true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], { method: 'DELETE', tags: [PENDING_BOOKING_TAG] });
  assert.deepEqual(calls[1], { method: 'POST', tags: [PENDING_BOOKING_TAG] });
  assert.deepEqual(calls[2], { method: 'DELETE', tags: [PENDING_BOOKING_TAG] });
  assert.deepEqual(calls[3], { method: 'POST', tags: [PENDING_BOOKING_TAG] });
});

test('confirm: removePendingBookingTag deletes niet-bevestigd', async () => {
  const { calls, fetchFn } = tagCallsFromFetch();
  const ok = await removePendingBookingTag('c-confirm', '[test]', null, {
    apiKey: 'test-key',
    fetchFn,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'DELETE', tags: [PENDING_BOOKING_TAG] });
});

test('pulseContactTag accepts custom delayMs without breaking post step', async () => {
  const { calls, fetchFn } = tagCallsFromFetch();
  const ok = await pulseContactTag('c-delay', 'andere-tag', '[test]', null, {
    apiKey: 'test-key',
    fetchFn,
    delayMs: 0,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].tags, ['andere-tag']);
});
