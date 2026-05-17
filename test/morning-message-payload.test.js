import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMorningMessageAppointmentsFromRouteState,
  buildMorningWindowForContact,
  buildMorningWindowPhrase,
  roundToQuarterMinutes,
} from '../lib/morning-message-payload.js';

const routeState = {
  orderContactIds: ['first-cid', 'second-cid', 'third-cid', 'fourth-cid'],
  etasByContactId: {
    'first-cid': '09:15',
    'second-cid': '10:30',
    'third-cid': '11:00',
    'fourth-cid': '16:00',
  },
  internalFixedStartByContactId: {
    'first-cid': { type: 'exact', time: '09:30' },
    'third-cid': { type: 'exact', time: '11:00' },
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
  assert.equal(row.windowPhrase, 'om 09:30');
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
  assert.equal(row.windowPhrase, 'om 09:00');
});

test('middle customer with ETA 10:30 gets window phrase and ETA as start time', () => {
  const row = buildMorningWindowForContact({
    contactId: 'second-cid',
    orderContactIds: routeState.orderContactIds,
    etasByContactId: routeState.etasByContactId,
    internalFixedStartByContactId: routeState.internalFixedStartByContactId,
  });
  assert.equal(row.plannedValue, '10:30');
  assert.equal(row.windowPhrase, 'tussen 09:30 en 11:30');
  assert.equal(row.timeFrom, '09:30');
  assert.equal(row.timeTo, '11:30');
});

test('customer with internalFixedStart.exact uses om phrase without window', () => {
  const row = buildMorningWindowForContact({
    contactId: 'third-cid',
    orderContactIds: routeState.orderContactIds,
    etasByContactId: routeState.etasByContactId,
    internalFixedStartByContactId: routeState.internalFixedStartByContactId,
  });
  assert.equal(row.plannedValue, '11:00');
  assert.equal(row.windowPhrase, 'om 11:00');
});

test('late customer with ETA 16:00 gets tussen 15:00 en 17:00', () => {
  const row = buildMorningWindowForContact({
    contactId: 'fourth-cid',
    orderContactIds: routeState.orderContactIds,
    etasByContactId: routeState.etasByContactId,
    internalFixedStartByContactId: routeState.internalFixedStartByContactId,
  });
  assert.equal(row.plannedValue, '16:00');
  assert.equal(row.windowPhrase, 'tussen 15:00 en 17:00');
});

test('ETA 14:15 → tussen 13:15 en 15:15', () => {
  const row = buildMorningWindowForContact({
    contactId: 'third-cid',
    orderContactIds: ['a', 'b', 'third-cid'],
    etasByContactId: { 'third-cid': '14:15' },
    internalFixedStartByContactId: {},
  });
  assert.equal(row.plannedValue, '14:15');
  assert.equal(row.windowPhrase, 'tussen 13:15 en 15:15');
});

test('buildMorningWindowPhrase formats exact and range', () => {
  assert.equal(buildMorningWindowPhrase({ timeFrom: '09:00', timeTo: '09:00', isExactStart: true }), 'om 09:00');
  assert.equal(
    buildMorningWindowPhrase({ timeFrom: '09:30', timeTo: '11:30', isExactStart: false }),
    'tussen 09:30 en 11:30'
  );
});

test('roundToQuarterMinutes rounds to nearest 15', () => {
  assert.equal(roundToQuarterMinutes(67), 60);
  assert.equal(roundToQuarterMinutes(68), 75);
});

test('buildMorningMessageAppointmentsFromRouteState preserves order', () => {
  const rows = buildMorningMessageAppointmentsFromRouteState(routeState);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].contactId, 'first-cid');
  assert.equal(rows[1].contactId, 'second-cid');
});
