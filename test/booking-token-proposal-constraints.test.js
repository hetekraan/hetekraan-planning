import test from 'node:test';
import assert from 'node:assert/strict';
import { signBookingToken, verifyBookingToken } from '../lib/session.js';

test('booking token roundtrips proposalConstraints (excludedDates / snapshot)', () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-token-roundtrip';
  const payload = {
    contactId: 'c-test',
    name: 'Test',
    phone: '',
    email: 'a@b.nl',
    address: 'Teststraat 1 1234AB Testdam',
    type: 'onderhoud',
    inviteIssuedAt: 1,
    tokenSchemaVersion: 2,
    intakeData: { minStartDate: '', customerUnavailability: '2026-06-01 niet' },
    proposalConstraints: {
      allowedDates: ['2026-05-12', '2026-05-13'],
      datesOnly: true,
      excludedDates: ['2026-05-12'],
    },
    slots: [
      {
        id: '2026-05-13_morning',
        dateStr: '2026-05-13',
        block: 'morning',
        label: 'Test ochtend',
        time: '09:00–12:00',
      },
    ],
  };
  const token = signBookingToken(payload);
  const out = verifyBookingToken(token);
  assert.ok(out);
  assert.deepEqual(out.proposalConstraints, payload.proposalConstraints);
  assert.equal(out.intakeData.customerUnavailability, '2026-06-01 niet');
});
