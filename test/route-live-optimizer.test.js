import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRouteAppointments,
  mergeInternalFixedFromAppointments,
  mergeRouteOrderPreservingStatus,
  preservedActiveOrderFromRouteState,
  triggerLiveRouteRecalculation,
} from '../lib/route-live-optimizer.js';

function routeState(overrides = {}) {
  return {
    schemaVersion: 1,
    dateStr: '2026-05-20',
    revision: 3,
    routeStatus: 'live',
    orderContactIds: ['c1', 'c2'],
    etasByContactId: { c1: '09:00', c2: '10:00' },
    pinsByContactId: {},
    internalFixedStartByContactId: {},
    lastOptimizedAt: 1760000000000,
    lastRouteInputChangedAt: 1760000000000,
    routeInputFingerprint: 'fp-old',
    optimizerVersion: 'partitioned-day-v1',
    updatedAt: 1760000000000,
    updatedBy: 'test',
    source: 'test',
    migratedFromLegacy: false,
    ...overrides,
  };
}

function appointments() {
  return [
    { contactId: 'c1', status: 'ingepland', fullAddressLine: 'A straat 1', timeSlot: '09:00' },
    { contactId: 'c2', status: 'onderweg', fullAddressLine: 'B straat 2', timeSlot: '10:00' },
    { contactId: 'klaar-1', status: 'klaar', fullAddressLine: 'C straat 3', timeSlot: '11:00' },
  ];
}

test('activeRouteAppointments excludes klaar appointments', () => {
  assert.deepEqual(
    activeRouteAppointments(appointments()).map((a) => a.contactId),
    ['c1', 'c2']
  );
});

test('triggerLiveRouteRecalculation writes auto optimized live route', async () => {
  const calls = { optimize: [], write: [] };
  const initial = routeState();
  const out = await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: appointments(),
    reason: 'createAppointment',
    updatedBy: 'daan',
    deps: {
      ensureRouteLiveState: async () => ({ ok: true, routeState: initial }),
      optimizeRoute: async ({ appointments: rows }) => {
        calls.optimize.push(rows);
        return {
          orderContactIds: rows.map((a) => a.contactId).reverse(),
          etasByContactId: Object.fromEntries(rows.map((a, idx) => [a.contactId, `${9 + idx}:00`])),
        };
      },
      setRouteLiveState: async (_loc, _date, payload) => {
        calls.write.push(payload);
        return { ok: true, routeState: { ...payload, revision: 4 } };
      },
    },
  });

  assert.equal(out.ok, true);
  assert.deepEqual(
    calls.optimize[0].map((a) => a.contactId),
    ['c1', 'c2']
  );
  assert.equal(calls.write[0].expectedRevision, 3);
  assert.equal(calls.write[0].source, 'auto_optimize');
  assert.equal(calls.write[0].updatedBy, 'daan');
  assert.deepEqual(out.routeState.orderContactIds, ['c2', 'c1']);
});

test('preservedActiveOrderFromRouteState keeps relative order when one is klaar', () => {
  const order = preservedActiveOrderFromRouteState(
    routeState({ orderContactIds: ['c2', 'c1', 'klaar-1'] }),
    [{ contactId: 'c1', status: 'ingepland' }]
  );
  assert.deepEqual(order, ['c1']);
});

test('mergeRouteOrderPreservingStatus keeps klaar contacts in place', () => {
  const order = mergeRouteOrderPreservingStatus(
    routeState({ orderContactIds: ['c2', 'c1'] }),
    [{ contactId: 'c1', status: 'ingepland' }]
  );
  assert.deepEqual(order, ['c2', 'c1']);
});

test('triggerLiveRouteRecalculation preserves order after completeAppointment', async () => {
  const initial = routeState({ orderContactIds: ['c2', 'c1'] });
  const rows = [
    { contactId: 'c2', status: 'klaar', fullAddressLine: 'B', timeSlot: '09:00' },
    { contactId: 'c1', status: 'ingepland', fullAddressLine: 'A', timeSlot: '10:00' },
  ];
  const out = await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: rows,
    reason: 'completeAppointment',
    deps: {
      ensureRouteLiveState: async () => ({ ok: true, routeState: initial }),
      optimizeRoute: async ({ appointments: activeRows }) => ({
        orderContactIds: activeRows.map((a) => a.contactId).reverse(),
        etasByContactId: { c1: '11:00' },
      }),
      setRouteLiveState: async (_loc, _date, payload) => ({
        ok: true,
        routeState: { ...payload, revision: 4 },
      }),
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.routeState.orderContactIds, ['c2', 'c1']);
});

test('mergeInternalFixedFromAppointments sets, overwrites and removes constraints', () => {
  const merged = mergeInternalFixedFromAppointments(
    { internalFixedStartByContactId: { c1: { type: 'exact', time: '09:00' }, c9: { type: 'after', time: '08:00' } } },
    [
      { contactId: 'c1', internalFixedStart: { type: 'after', time: '10:00' } }, // overschrijf
      { contactId: 'c2' }, // geen pin → niet toegevoegd
      { contactId: 'c3', internalFixedStart: '11:30' }, // legacy plain → exact
    ]
  );
  assert.deepEqual(merged.c1, { type: 'after', time: '10:00' });
  assert.deepEqual(merged.c3, { type: 'exact', time: '11:30' });
  assert.equal(merged.c2, undefined);
  assert.deepEqual(merged.c9, { type: 'after', time: '08:00' }, 'contact buiten lijst blijft staan');
});

test('mergeInternalFixedFromAppointments deletes when constraint removed', () => {
  const merged = mergeInternalFixedFromAppointments(
    { internalFixedStartByContactId: { c1: { type: 'exact', time: '09:00' } } },
    [{ contactId: 'c1' }] // pin verwijderd
  );
  assert.equal(merged.c1, undefined);
});

test('setInternalFixedStart recalc preserves manual order and updates fixed map', async () => {
  const initial = routeState({ orderContactIds: ['c1', 'c2'] });
  const rows = [
    { contactId: 'c1', status: 'ingepland', fullAddressLine: 'A', timeSlot: '09:00', internalFixedStart: { type: 'after', time: '10:00' } },
    { contactId: 'c2', status: 'ingepland', fullAddressLine: 'B', timeSlot: '10:30' },
  ];
  const calls = { write: [] };
  const out = await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: rows,
    reason: 'setInternalFixedStart',
    deps: {
      ensureRouteLiveState: async () => ({ ok: true, routeState: initial }),
      // Simuleer de echte optimizer: bij preserveOrder blijft de volgorde staan.
      optimizeRoute: async ({ appointments: act, preserveOrder }) => ({
        orderContactIds: preserveOrder ? act.map((a) => a.contactId) : act.map((a) => a.contactId).reverse(),
        etasByContactId: Object.fromEntries(act.map((a) => [a.contactId, '09:00'])),
        violationsByContactId: {},
      }),
      setRouteLiveState: async (_loc, _date, payload) => {
        calls.write.push(payload);
        return { ok: true, routeState: { ...payload, revision: 4 } };
      },
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.routeState.orderContactIds, ['c1', 'c2'], 'handmatige volgorde blijft staan');
  assert.deepEqual(calls.write[0].internalFixedStartByContactId.c1, { type: 'after', time: '10:00' });
  assert.equal(calls.write[0].internalFixedStartByContactId.c2, undefined);
});

test('triggerLiveRouteRecalculation logs failure but does not throw', async () => {
  const out = await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: appointments(),
    reason: 'updatePlannerBookingDetails',
    deps: {
      ensureRouteLiveState: async () => ({ ok: true, routeState: routeState() }),
      optimizeRoute: async () => {
        throw new Error('maps failed');
      },
      setRouteLiveState: async () => {
        throw new Error('should not write');
      },
    },
  });

  assert.equal(out.ok, false);
  assert.equal(out.code, 'ROUTE_RECALC_FAILED');
});
