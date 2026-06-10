import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRouteAppointments,
  mergeInternalFixedFromAppointments,
  mergeRouteOrderPreservingStatus,
  pinsWithoutDayPart,
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

test('pinsWithoutDayPart drops only the targeted day part pins', () => {
  const active = [
    { contactId: 'm1', dayPart: 0 },
    { contactId: 'a1', dayPart: 1 },
    { contactId: 'a2', dayPart: 1 },
  ];
  const pins = { m1: { type: 'manual_order' }, a1: { type: 'manual_order' }, a2: { type: 'manual_order' } };
  assert.deepEqual(pinsWithoutDayPart(pins, active, 1), { m1: { type: 'manual_order' } });
  assert.deepEqual(pinsWithoutDayPart(pins, active, 0), {
    a1: { type: 'manual_order' },
    a2: { type: 'manual_order' },
  });
});

test('pinsWithoutDayPart keeps pins of contacts no longer active', () => {
  const pins = { gone: { type: 'manual_order' }, a1: { type: 'manual_order' } };
  const active = [{ contactId: 'a1', dayPart: 1 }];
  assert.deepEqual(pinsWithoutDayPart(pins, active, 1), { gone: { type: 'manual_order' } });
});

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

test('setInternalFixedStart optimizes the changed afternoon day part, preserves morning, clears afternoon pins', async () => {
  const initial = routeState({
    orderContactIds: ['m1', 'a1', 'a2'],
    pinsByContactId: { m1: { type: 'manual_order' }, a1: { type: 'manual_order' } },
  });
  const rows = [
    { contactId: 'm1', status: 'ingepland', fullAddressLine: 'M1', dayPart: 0 },
    { contactId: 'a1', status: 'ingepland', fullAddressLine: 'A1', dayPart: 1 },
    { contactId: 'a2', status: 'ingepland', fullAddressLine: 'A2', dayPart: 1, internalFixedPin: { type: 'after', time: '15:00' } },
  ];
  const calls = { optimize: [], write: [] };
  const out = await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: rows,
    reason: 'setInternalFixedStart',
    changedContactId: 'a2',
    deps: recordingDeps(initial, calls),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.optimize[0].preserveOrder, { morning: true, afternoon: false });
  assert.deepEqual(calls.write[0].pinsByContactId, { m1: { type: 'manual_order' } });
});

test('setInternalFixedStart optimizes the changed morning day part, preserves afternoon, clears morning pins', async () => {
  const initial = routeState({
    orderContactIds: ['m1', 'm2', 'a1'],
    pinsByContactId: { m1: { type: 'manual_order' }, a1: { type: 'manual_order' } },
  });
  const rows = [
    { contactId: 'm1', status: 'ingepland', fullAddressLine: 'M1', dayPart: 0, internalFixedPin: { type: 'after', time: '10:00' } },
    { contactId: 'm2', status: 'ingepland', fullAddressLine: 'M2', dayPart: 0 },
    { contactId: 'a1', status: 'ingepland', fullAddressLine: 'A1', dayPart: 1 },
  ];
  const calls = { optimize: [], write: [] };
  await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: rows,
    reason: 'setInternalFixedStart',
    changedContactId: 'm1',
    deps: recordingDeps(initial, calls),
  });
  assert.deepEqual(calls.optimize[0].preserveOrder, { morning: false, afternoon: true });
  assert.deepEqual(calls.write[0].pinsByContactId, { a1: { type: 'manual_order' } });
});

test('setInternalFixedStart with removed constraint preserves order and keeps all pins', async () => {
  const initial = routeState({
    orderContactIds: ['m1', 'a1', 'a2'],
    pinsByContactId: { m1: { type: 'manual_order' }, a1: { type: 'manual_order' } },
  });
  const rows = [
    { contactId: 'm1', status: 'ingepland', fullAddressLine: 'M1', dayPart: 0 },
    { contactId: 'a1', status: 'ingepland', fullAddressLine: 'A1', dayPart: 1 },
    { contactId: 'a2', status: 'ingepland', fullAddressLine: 'A2', dayPart: 1 }, // pin verwijderd
  ];
  const calls = { optimize: [], write: [] };
  await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    appointments: rows,
    reason: 'setInternalFixedStart',
    changedContactId: 'a2',
    deps: recordingDeps(initial, calls),
  });
  assert.equal(calls.optimize[0].preserveOrder, true, 'geen per-dagdeel optimize bij verwijderde constraint');
  assert.deepEqual(calls.write[0].pinsByContactId, {
    m1: { type: 'manual_order' },
    a1: { type: 'manual_order' },
  });
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
