import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMorningMessageAppointmentsFromRouteState,
  buildMorningWindowForContact,
  buildMorningWindowPhrase,
  formatEtaSentPillLabel,
  formatMorningWindowPillLabel,
  resolveMorningSentWindowForContact,
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

test('formatMorningWindowPillLabel: exact, range, plannedValue fallback, empty', () => {
  assert.equal(formatMorningWindowPillLabel({ timeFrom: '09:00', timeTo: '09:00' }), 'Slot om 09:00');
  assert.equal(formatMorningWindowPillLabel({ timeFrom: '11:00', timeTo: '13:00' }), 'Slot 11:00-13:00');
  assert.equal(formatMorningWindowPillLabel({ plannedValue: '10:30' }), 'Slot om 10:30');
  assert.equal(formatMorningWindowPillLabel({ timeFrom: '', timeTo: '' }), '');
  assert.equal(formatMorningWindowPillLabel(null), '');
  assert.equal(formatMorningWindowPillLabel({}), '');
});

test('formatEtaSentPillLabel: valid time and fallback', () => {
  assert.equal(formatEtaSentPillLabel('09:45'), 'ETA 09:45');
  assert.equal(formatEtaSentPillLabel('  10:00 '), 'ETA 10:00');
  assert.equal(formatEtaSentPillLabel(''), 'ETA verstuurd');
  assert.equal(formatEtaSentPillLabel('onzin'), 'ETA verstuurd');
});

test('resolveMorningSentWindowForContact returns window when contact was in batch', () => {
  const settings = {
    lastSentAt: 1760000000000,
    lastSentContactIds: ['c1', 'c2'],
    lastSentWindowsByContactId: {
      c1: { timeFrom: '09:00', timeTo: '11:00', plannedValue: '09:00' },
    },
  };
  assert.deepEqual(resolveMorningSentWindowForContact(settings, 'c1'), {
    timeFrom: '09:00',
    timeTo: '11:00',
    plannedValue: '09:00',
  });
});

test('resolveMorningSentWindowForContact returns null when not in batch / no send / no window', () => {
  const base = {
    lastSentAt: 1760000000000,
    lastSentContactIds: ['c1'],
    lastSentWindowsByContactId: { c1: { timeFrom: '09:00', timeTo: '11:00' } },
  };
  // contact niet in batch
  assert.equal(resolveMorningSentWindowForContact(base, 'c2'), null);
  // geen ochtendmelding verstuurd
  assert.equal(resolveMorningSentWindowForContact({ ...base, lastSentAt: null }, 'c1'), null);
  // window-entry mist
  assert.equal(
    resolveMorningSentWindowForContact({ ...base, lastSentWindowsByContactId: {} }, 'c1'),
    null
  );
  // window zonder bruikbare tijd
  assert.equal(
    resolveMorningSentWindowForContact(
      { ...base, lastSentWindowsByContactId: { c1: { timeFrom: '', timeTo: '' } } },
      'c1'
    ),
    null
  );
  // geen settings
  assert.equal(resolveMorningSentWindowForContact(null, 'c1'), null);
});
