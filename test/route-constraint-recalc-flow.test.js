import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerLiveRouteRecalculationForDate } from '../api/ghl.js';

function routeState(overrides = {}) {
  return {
    schemaVersion: 1,
    dateStr: '2026-05-20',
    revision: 3,
    routeStatus: 'live',
    orderContactIds: ['m1', 'a1', 'a2'],
    etasByContactId: {},
    pinsByContactId: { m1: { type: 'manual_order' }, a1: { type: 'manual_order' } },
    internalFixedStartByContactId: {},
    updatedAt: 1760000000000,
    ...overrides,
  };
}

function recordingDeps(initial, calls) {
  return {
    ensureRouteLiveState: async () => ({ ok: true, routeState: initial }),
    optimizeRoute: async ({ appointments: act, preserveOrder }) => {
      calls.optimize.push({ ids: act.map((a) => a.contactId), preserveOrder });
      return {
        orderContactIds: act.map((a) => a.contactId),
        etasByContactId: Object.fromEntries(act.map((a) => [a.contactId, '09:00'])),
        violationsByContactId: {},
      };
    },
    setRouteLiveState: async (_loc, _date, payload) => {
      calls.write.push(payload);
      return { ok: true, routeState: { ...payload, revision: 4 } };
    },
  };
}

test('changedContactId flows from triggerLiveRouteRecalculationForDate into per-daypart optimize', async () => {
  const rows = [
    { contactId: 'm1', status: 'ingepland', fullAddressLine: 'M1', dayPart: 0 },
    { contactId: 'a1', status: 'ingepland', fullAddressLine: 'A1', dayPart: 1 },
    {
      contactId: 'a2',
      status: 'ingepland',
      fullAddressLine: 'A2',
      dayPart: 1,
      internalFixedPin: { type: 'after', time: '15:00' },
    },
  ];
  const calls = { optimize: [], write: [] };
  const out = await triggerLiveRouteRecalculationForDate('loc-1', '2026-05-20', 'setInternalFixedStart', {
    changedContactId: 'a2',
    loadAppointmentsForDate: async () => ({ appointments: rows }),
    deps: recordingDeps(routeState(), calls),
  });

  assert.equal(out.ok, true);
  // Het dagdeel van de gewijzigde stop (middag) wordt heroptimaliseerd, ochtend preserved.
  assert.deepEqual(calls.optimize[0].preserveOrder, { morning: true, afternoon: false });
  // Manual-order pins van de middag zijn gewist; ochtendpin blijft staan.
  assert.deepEqual(calls.write[0].pinsByContactId, { m1: { type: 'manual_order' } });
});

test('removed constraint via full flow preserves order and keeps pins', async () => {
  const rows = [
    { contactId: 'm1', status: 'ingepland', fullAddressLine: 'M1', dayPart: 0 },
    { contactId: 'a1', status: 'ingepland', fullAddressLine: 'A1', dayPart: 1 },
    { contactId: 'a2', status: 'ingepland', fullAddressLine: 'A2', dayPart: 1 }, // geen pin meer
  ];
  const calls = { optimize: [], write: [] };
  await triggerLiveRouteRecalculationForDate('loc-1', '2026-05-20', 'setInternalFixedStart', {
    changedContactId: 'a2',
    loadAppointmentsForDate: async () => ({ appointments: rows }),
    deps: recordingDeps(routeState(), calls),
  });

  assert.equal(calls.optimize[0].preserveOrder, true);
  assert.deepEqual(calls.write[0].pinsByContactId, {
    m1: { type: 'manual_order' },
    a1: { type: 'manual_order' },
  });
});

test('triggerLiveRouteRecalculationForDate rejects an invalid date', async () => {
  const out = await triggerLiveRouteRecalculationForDate('loc-1', 'not-a-date', 'setInternalFixedStart', {
    changedContactId: 'a2',
    loadAppointmentsForDate: async () => ({ appointments: [] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_DATE');
});
