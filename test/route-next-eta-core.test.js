import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRouteContactIds,
  buildNextEtaPreview,
  findNextNonKlaarContactId,
  resolveSendNextEta,
} from '../lib/route-next-eta-core.js';

const appointments = [
  { contactId: 'c1', status: 'klaar', fullAddressLine: 'A 1', name: 'Anna' },
  { contactId: 'c2', status: 'ingepland', fullAddressLine: 'B 2', name: 'Bert' },
  { contactId: 'c3', status: 'ingepland', fullAddressLine: 'C 3', name: 'Chris' },
  { contactId: 'block', isCalBlock: true, status: 'ingepland' },
];

const routeState = {
  orderContactIds: ['c1', 'c2', 'c3'],
  etasByContactId: { c2: '11:00', c3: '12:00' },
};

test('findNextNonKlaarContactId skips klaar stops', () => {
  const active = activeRouteContactIds(appointments);
  assert.equal(findNextNonKlaarContactId(routeState.orderContactIds, active, 'c1'), 'c2');
  assert.equal(findNextNonKlaarContactId(routeState.orderContactIds, active, 'c3'), null);
});

test('buildNextEtaPreview returns next contact with eta', async () => {
  const out = await buildNextEtaPreview({
    routeState,
    appointments,
    currentContactId: 'c1',
    travelMinutesFn: async () => 25,
  });
  assert.equal(out.ok, true);
  assert.equal(out.nextContact?.id, 'c2');
  assert.match(out.etaTime, /^\d{2}:\d{2}$/);
});

test('buildNextEtaPreview no next after last active', async () => {
  const out = await buildNextEtaPreview({
    routeState,
    appointments: [
      { contactId: 'c1', status: 'klaar', fullAddressLine: 'A' },
      { contactId: 'c2', status: 'klaar', fullAddressLine: 'B' },
    ],
    currentContactId: 'c1',
    travelMinutesFn: async () => 10,
  });
  assert.equal(out.nextContact, null);
});

test('buildNextEtaPreview maps failure', async () => {
  const out = await buildNextEtaPreview({
    routeState,
    appointments,
    currentContactId: 'c1',
    travelMinutesFn: async () => null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ETA_CALC_FAILED');
  assert.equal(out.nextContact?.id, 'c2');
});

test('resolveSendNextEta uses server eta when client differs >5 min', async () => {
  const out = await resolveSendNextEta({
    routeState,
    appointments,
    currentContactId: 'c1',
    nextContactId: 'c2',
    clientEta: '09:00',
    travelMinutesFn: async () => 30,
  });
  assert.equal(out.ok, true);
  assert.notEqual(out.sentEta, '09:00');
});

test('resolveSendNextEta rejects stale next contact', async () => {
  const out = await resolveSendNextEta({
    routeState,
    appointments,
    currentContactId: 'c1',
    nextContactId: 'unknown',
    clientEta: '10:00',
    travelMinutesFn: async () => 10,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'STALE_CONTACT_ID');
});
