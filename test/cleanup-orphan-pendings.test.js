import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING_FORM_FIELD_IDS } from '../lib/booking-canon-fields.js';
import { cleanupOrphanPendingReservations } from '../lib/cleanup-orphan-pendings.js';

test('cleanup: removes pending when boekingsvoorstel_optie_2 is set', async () => {
  const pendingRow = {
    id: 'r-orphan',
    contactId: 'c-two-slot',
    dateStr: '2026-05-20',
    block: 'morning',
    status: 'pending',
    createdAt: 1,
  };

  let removed = false;
  let ghlPutBody = null;

  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/contacts/c-two-slot') && init.method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          contact: {
            id: 'c-two-slot',
            customFields: [
              {
                id: BOOKING_FORM_FIELD_IDS.boekingsvoorstel_optie_2,
                value: 'Woensdag tussen 13:00–17:00',
              },
            ],
          },
        }),
      };
    }
    if (u.includes('/contacts/c-two-slot') && init.method === 'PUT') {
      ghlPutBody = JSON.parse(String(init.body));
      return { ok: true, text: async () => '{}' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const out = await cleanupOrphanPendingReservations({
    apiKey: 'test-key',
    fetchFn,
    listPendingFn: async () => [pendingRow],
    removeFn: async () => {
      removed = true;
    },
    invalidateFn: () => {},
  });

  assert.equal(out.ok, true);
  assert.equal(out.removedCount, 1);
  assert.equal(removed, true);
  assert.ok(ghlPutBody?.customFields?.length >= 3);
});

test('cleanup: skips pending when only one slot option (no optie 2)', async () => {
  const pendingRow = {
    id: 'r-keep',
    contactId: 'c-one-slot',
    dateStr: '2026-05-21',
    block: 'afternoon',
    status: 'pending',
    createdAt: 1,
  };

  const fetchFn = async (url, init = {}) => {
    if (String(url).includes('/contacts/c-one-slot') && init.method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          contact: {
            id: 'c-one-slot',
            customFields: [
              {
                id: BOOKING_FORM_FIELD_IDS.boekingsvoorstel_optie_1,
                value: 'Dinsdag ochtend',
              },
            ],
          },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const out = await cleanupOrphanPendingReservations({
    apiKey: 'test-key',
    fetchFn,
    listPendingFn: async () => [pendingRow],
    removeFn: async () => {
      throw new Error('should not remove');
    },
    invalidateFn: () => {},
  });

  assert.equal(out.removedCount, 0);
  assert.equal(out.skipped[0]?.reason, 'not_two_slot_invite');
});
