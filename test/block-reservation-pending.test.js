import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeReservationsToSyntheticEvents,
  pendingReservationsToSyntheticEvents,
  confirmedReservationsToSyntheticEvents,
  reservationToSyntheticCalendarEvent,
} from '../lib/block-reservation-store.js';
import { blockAllowsNewCustomerBooking, customerMaxForBlock } from '../lib/booking-blocks.js';

test('pending synthetic event is flagged for planner', () => {
  const ev = reservationToSyntheticCalendarEvent({
    id: 'r1',
    contactId: 'c1',
    dateStr: '2026-05-20',
    block: 'morning',
    workType: 'onderhoud',
    status: 'pending',
    createdAt: 1,
  });
  assert.equal(ev._hkPendingBooking, true);
  assert.equal(ev._hkReservationStatus, 'pending');
  assert.equal(ev._hkSyntheticBlock, 'morning');
});

test('confirmed synthetic event is not pending', () => {
  const ev = reservationToSyntheticCalendarEvent({
    id: 'r2',
    contactId: 'c2',
    dateStr: '2026-05-20',
    block: 'afternoon',
    workType: 'reparatie',
    status: 'confirmed',
    createdAt: 1,
  });
  assert.equal(ev._hkPendingBooking, false);
});

test('active reservations include pending and confirmed for capacity', () => {
  const rows = [
    {
      id: 'p1',
      contactId: 'c-pending',
      dateStr: '2026-05-20',
      block: 'morning',
      workType: 'onderhoud',
      status: 'pending',
      createdAt: 1,
    },
    {
      id: 'c1',
      contactId: 'c-confirmed',
      dateStr: '2026-05-20',
      block: 'morning',
      workType: 'onderhoud',
      status: 'confirmed',
      createdAt: 2,
    },
  ];
  const active = activeReservationsToSyntheticEvents(rows);
  assert.equal(active.length, 2);
  const pendingOnly = pendingReservationsToSyntheticEvents(rows);
  assert.equal(pendingOnly.length, 1);
  const confirmedOnly = confirmedReservationsToSyntheticEvents(rows);
  assert.equal(confirmedOnly.length, 1);
});

test('pending synthetic counts toward block capacity', () => {
  const max = customerMaxForBlock('morning');
  const events = [];
  for (let i = 0; i < max; i += 1) {
    events.push(
      reservationToSyntheticCalendarEvent({
        id: `r${i}`,
        contactId: `c${i}`,
        dateStr: '2026-05-20',
        block: 'morning',
        workType: 'onderhoud',
        status: 'pending',
        createdAt: i,
      })
    );
  }
  assert.equal(blockAllowsNewCustomerBooking('morning', events, 'onderhoud'), false);
});
