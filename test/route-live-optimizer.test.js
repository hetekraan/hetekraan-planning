import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRouteAppointments,
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
