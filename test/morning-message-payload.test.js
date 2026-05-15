import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMorningMessageAppointmentsFromRouteState,
  buildMorningWindowForContact,
  roundToQuarterMinutes,
} from '../lib/morning-message-payload.js';

const routeState = {
  orderContactIds: ['first-cid', 'second-cid', 'third-cid'],
  etasByContactId: {
    'first-cid': '09:15',
    'second-cid': '10:30',
    'third-cid': '14:15',
  },
  internalFixedStartByContactId: {
    'first-cid': { type: 'exact', time: '09:30' },
  },
};

test('first route stop uses exact internalFixedStart time', () => {
  const row = buildMorningWindowForContact({
    contactId: 'first-cid',
    orderContactIds: routeState.orderContactIds,
    etasByContactId: routeState.etasByContactId,
    internalFixedStartByContactId: routeState.internalFixedStartByContactId,
  });
  assert.equal(row.plannedValue, '09:30');
  assert.equal(row.timeFrom, '09:30');
  assert.equal(row.timeTo, '09:30');
});

test('first route stop without pin uses 09:00 default', () => {
  const row = buildMorningWindowForContact({
    contactId: 'first-cid',
    orderContactIds: ['first-cid'],
    etasByContactId: { 'first-cid': '10:00' },
    internalFixedStartByContactId: {},
  });
  assert.equal(row.plannedValue, '09:00');
});

test('other stops use 2-hour window rounded to quarters', () => {
  const row = buildMorningWindowForContact({
    contactId: 'second-cid',
    orderContactIds: routeState.orderContactIds,
    etasByContactId: routeState.etasByContactId,
    internalFixedStartByContactId: routeState.internalFixedStartByContactId,
  });
  assert.equal(row.plannedValue, '09:30-11:30');
  assert.equal(row.timeFrom, '09:30');
  assert.equal(row.timeTo, '11:30');
});

test('ETA 14:15 → 13:15–15:15', () => {
  const row = buildMorningWindowForContact({
    contactId: 'third-cid',
    orderContactIds: routeState.orderContactIds,
    etasByContactId: routeState.etasByContactId,
    internalFixedStartByContactId: routeState.internalFixedStartByContactId,
  });
  assert.equal(row.plannedValue, '13:15-15:15');
});

test('roundToQuarterMinutes rounds to nearest 15', () => {
  assert.equal(roundToQuarterMinutes(67), 60);
  assert.equal(roundToQuarterMinutes(68), 75);
});

test('buildMorningMessageAppointmentsFromRouteState preserves order', () => {
  const rows = buildMorningMessageAppointmentsFromRouteState(routeState);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].contactId, 'first-cid');
  assert.equal(rows[1].contactId, 'second-cid');
});
