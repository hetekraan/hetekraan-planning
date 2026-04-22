import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contactHasTag,
  ensureReviewMailTagOnComplete,
  shouldQueueReviewMailTag,
} from '../lib/usecases/review-mail-tag.js';

test('shouldQueueReviewMailTag requires review toggle and klaar status', () => {
  assert.equal(shouldQueueReviewMailTag({ sendReview: true, status: 'klaar' }), true);
  assert.equal(shouldQueueReviewMailTag({ sendReview: false, status: 'klaar' }), false);
  assert.equal(shouldQueueReviewMailTag({ sendReview: true, status: 'ingepland' }), false);
});

test('contactHasTag supports string and object tags', () => {
  assert.equal(contactHasTag({ tags: ['review_mail_versturen'] }, 'review_mail_versturen'), true);
  assert.equal(contactHasTag({ tags: [{ name: 'review_mail_versturen' }] }, 'review_mail_versturen'), true);
  assert.equal(contactHasTag({ tags: ['factuur-versturen'] }, 'review_mail_versturen'), false);
});

test('ensureReviewMailTagOnComplete skips when conditions are not met', async () => {
  const result = await ensureReviewMailTagOnComplete({
    contactId: 'c-1',
    sendReview: false,
    status: 'klaar',
    apiKey: 'x',
    locationId: 'y',
    fetchImpl: async () => {
      throw new Error('should_not_call_fetch');
    },
  });
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'conditions_not_met');
});

test('ensureReviewMailTagOnComplete does not add duplicate tag', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ contact: { id: 'c-1', tags: ['review_mail_versturen'] } }),
      text: async () => '',
    };
  };
  const result = await ensureReviewMailTagOnComplete({
    contactId: 'c-1',
    sendReview: true,
    status: 'klaar',
    apiKey: 'x',
    locationId: 'loc-1',
    fetchImpl: fakeFetch,
  });
  assert.equal(result.reason, 'tag_already_exists');
  assert.equal(result.tagAdded, false);
  assert.equal(result.repeatCompletion, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('ensureReviewMailTagOnComplete skips when contact identifier is missing', async () => {
  const result = await ensureReviewMailTagOnComplete({
    contactId: '   ',
    appointmentId: 'a-1',
    sendReview: true,
    status: 'klaar',
    apiKey: 'x',
    locationId: 'loc-1',
    fetchImpl: async () => {
      throw new Error('should_not_call_fetch');
    },
  });
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'missing_contact_id');
});

test('ensureReviewMailTagOnComplete adds tag when missing', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if ((init.method || 'GET') === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ contact: { id: 'c-2', tags: ['factuur-versturen'] } }),
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    };
  };
  const result = await ensureReviewMailTagOnComplete({
    contactId: 'c-2',
    sendReview: true,
    status: 'klaar',
    apiKey: 'x',
    locationId: 'loc-1',
    fetchImpl: fakeFetch,
  });
  assert.equal(result.reason, 'tag_added');
  assert.equal(result.tagAdded, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
});
