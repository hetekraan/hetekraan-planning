import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING_FORM_FIELD_IDS } from '../lib/booking-canon-fields.js';
import { appendBookingCanonFields } from '../lib/booking-canon-fields.js';
import { signBookingToken, verifyBookingToken } from '../lib/session.js';
import {
  shouldCreatePendingReservationForInviteSlots,
  invitePendingCanonExtras,
  inviteTokenReservationFields,
} from '../api/send-booking-invite.js';

const oneSlot = [{ dateStr: '2026-05-20', block: 'morning' }];
const twoSlots = [
  { dateStr: '2026-05-20', block: 'morning' },
  { dateStr: '2026-05-21', block: 'afternoon' },
];

test('pending gate: 1-slot → should create pending reservation', () => {
  assert.equal(shouldCreatePendingReservationForInviteSlots(oneSlot), true);
});

test('pending gate: 2-slots → should NOT create pending reservation', () => {
  assert.equal(shouldCreatePendingReservationForInviteSlots(twoSlots), false);
});

test('canon pending fields: 1-slot → boeking_bevestigd_* written', () => {
  const extras = invitePendingCanonExtras(oneSlot, '2026-05-20', 'morning');
  assert.deepEqual(extras, {
    boeking_bevestigd_datum: '2026-05-20',
    boeking_bevestigd_dagdeel: 'morning',
    boeking_bevestigd_status: 'pending',
  });
  const { customFields } = appendBookingCanonFields([], {
    boekingsvoorstel_status: 'sent',
    ...extras,
  });
  const ids = customFields.map((f) => f.id);
  assert.ok(ids.includes(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum));
  assert.ok(ids.includes(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_dagdeel));
  assert.ok(ids.includes(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status));
});

test('canon pending fields: 2-slots → boeking_bevestigd_* NOT written', () => {
  const extras = invitePendingCanonExtras(twoSlots, '2026-05-20', 'morning');
  assert.deepEqual(extras, {});
  const { customFields } = appendBookingCanonFields(
    [],
    { boekingsvoorstel_status: 'sent', ...extras }
  );
  const ids = customFields.map((f) => f.id);
  assert.equal(ids.includes(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status), false);
  assert.equal(ids.includes(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum), false);
});

test('token: 1-slot with pending id → reservationId present', () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-pending-gate';
  const extra = inviteTokenReservationFields('res-uuid-1');
  assert.deepEqual(extra, { reservationId: 'res-uuid-1' });
  const token = signBookingToken({
    contactId: 'c1',
    tokenSchemaVersion: 3,
    slots: [{ id: '2026-05-20_morning', dateStr: '2026-05-20', block: 'morning' }],
    ...extra,
  });
  const decoded = verifyBookingToken(token);
  assert.equal(decoded.reservationId, 'res-uuid-1');
});

test('token: 2-slots without pending → no reservationId', () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-pending-gate';
  const extra = inviteTokenReservationFields('');
  assert.deepEqual(extra, {});
  const token = signBookingToken({
    contactId: 'c2',
    tokenSchemaVersion: 3,
    slots: [
      { id: '2026-05-20_morning', dateStr: '2026-05-20', block: 'morning' },
      { id: '2026-05-21_afternoon', dateStr: '2026-05-21', block: 'afternoon' },
    ],
    ...extra,
  });
  const decoded = verifyBookingToken(token);
  assert.equal(decoded.reservationId, undefined);
});

test('invite gate aligns with tag gate for 0/1/2 slots', async () => {
  const { shouldPulseNietBevestigdTagForInviteSlots } = await import('../api/send-booking-invite.js');
  assert.equal(
    shouldCreatePendingReservationForInviteSlots(oneSlot),
    shouldPulseNietBevestigdTagForInviteSlots(oneSlot)
  );
  assert.equal(
    shouldCreatePendingReservationForInviteSlots(twoSlots),
    shouldPulseNietBevestigdTagForInviteSlots(twoSlots)
  );
});
