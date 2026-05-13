import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
}

function loadRouteStorageContext() {
  const context = {
    console,
    localStorage: createLocalStorage(),
    currentDate: new Date('2026-05-13T10:00:00Z'),
    getDateStr: () => '2026-05-13',
    logEvents: [],
  };
  context.window = context;
  context.logRouteOrder = (event, payload) => {
    context.logEvents.push({ event, payload });
  };

  const snapshotJs = fs.readFileSync(
    new URL('../public/app/planner-route-snapshot.js', import.meta.url),
    'utf8'
  );
  vm.runInNewContext(snapshotJs, context);

  const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = indexHtml.indexOf('function routeSnapshotKey(dateStr)');
  const end = indexHtml.indexOf('function saveRouteLocalDraftForDate(dateStr, payload)');
  assert.ok(start > -1, 'route storage helper start not found');
  assert.ok(end > start, 'route storage helper end not found');
  vm.runInNewContext(indexHtml.slice(start, end), context);
  return context;
}

function legacyOrderPayload(order = ['c-1', 'c-2']) {
  return JSON.stringify({ savedAt: 100, contactIdsOrder: order });
}

function legacySnapshotPayload(order = ['c-1', 'c-2']) {
  return JSON.stringify({
    savedAt: 100,
    byContactId: { 'c-1': { timeSlot: '09:00', estimated: true } },
    contactIdsOrder: order,
    routeOperationalLock: {
      locked: true,
      savedAt: 100,
      orderContactIds: order,
      etasByContactId: { 'c-1': '09:00', 'c-2': '10:00' },
      internalFixedStartByContactId: { 'c-2': { type: 'exact', time: '10:00' } },
    },
  });
}

test('route localStorage migration copies legacy data when there is no central lock', () => {
  const ctx = loadRouteStorageContext();
  const date = '2026-05-13';
  ctx.localStorage.setItem(`hk_route_confirmed_order_${date}`, legacyOrderPayload());
  ctx.localStorage.setItem(`hk_route_times_${date}`, legacySnapshotPayload());

  ctx.migrateLegacyRouteLocalStorageForDate(date, null, true);

  assert.equal(ctx.localStorage.getItem(`hk_route_confirmed_order_${date}`), null);
  const migratedOrder = JSON.parse(ctx.localStorage.getItem(`hk_route_local_draft_order_${date}`));
  assert.deepEqual(migratedOrder.contactIdsOrder, ['c-1', 'c-2']);
  assert.equal(migratedOrder.sourceOfTruth, 'local_route_draft');

  const migratedSnapshot = JSON.parse(ctx.localStorage.getItem(`hk_route_times_${date}`));
  assert.equal(migratedSnapshot.routeOperationalLock, undefined);
  assert.deepEqual(migratedSnapshot.routeLocalDraft.contactIdsOrder, ['c-1', 'c-2']);
  assert.deepEqual(migratedSnapshot.routeLocalDraft.etasByContactId, { 'c-1': '09:00', 'c-2': '10:00' });
  assert.equal(ctx.logEvents.filter((e) => e.event === 'route_legacy_migration_applied').length, 1);
});

test('route localStorage migration deletes legacy data when central lock is confirmed', () => {
  const ctx = loadRouteStorageContext();
  const date = '2026-05-13';
  ctx.localStorage.setItem(`hk_route_confirmed_order_${date}`, legacyOrderPayload());
  ctx.localStorage.setItem(`hk_route_times_${date}`, legacySnapshotPayload());

  ctx.migrateLegacyRouteLocalStorageForDate(date, { locked: true }, true);

  assert.equal(ctx.localStorage.getItem(`hk_route_confirmed_order_${date}`), null);
  assert.equal(ctx.localStorage.getItem(`hk_route_local_draft_order_${date}`), null);
  const migratedSnapshot = JSON.parse(ctx.localStorage.getItem(`hk_route_times_${date}`));
  assert.equal(migratedSnapshot.routeOperationalLock, undefined);
  assert.equal(migratedSnapshot.routeLocalDraft, undefined);
});

test('route localStorage migration no-ops without legacy data', () => {
  const ctx = loadRouteStorageContext();
  const date = '2026-05-13';

  ctx.migrateLegacyRouteLocalStorageForDate(date, null, true);

  assert.equal(ctx.localStorage.getItem(`hk_route_confirmed_order_${date}`), null);
  assert.equal(ctx.localStorage.getItem(`hk_route_local_draft_order_${date}`), null);
  assert.equal(ctx.localStorage.getItem(`hk_route_times_${date}`), null);
  assert.equal(ctx.logEvents.filter((e) => e.event === 'route_legacy_migration_applied').length, 0);
});

test('route localStorage migration stays on legacy keys when feature flag is disabled', () => {
  const ctx = loadRouteStorageContext();
  const date = '2026-05-13';
  ctx.setRouteRefactorEnabledClient(false);
  ctx.localStorage.setItem(`hk_route_confirmed_order_${date}`, legacyOrderPayload(['c-old']));
  ctx.localStorage.setItem(`hk_route_times_${date}`, legacySnapshotPayload(['c-old']));

  ctx.migrateLegacyRouteLocalStorageForDate(date, null, true);
  ctx.saveLocalDraftRouteOrder(date, ['c-new']);

  assert.equal(ctx.localStorage.getItem(`hk_route_local_draft_order_${date}`), null);
  const legacyOrder = JSON.parse(ctx.localStorage.getItem(`hk_route_confirmed_order_${date}`));
  assert.deepEqual(legacyOrder.contactIdsOrder, ['c-new']);
  const legacySnapshot = JSON.parse(ctx.localStorage.getItem(`hk_route_times_${date}`));
  assert.ok(legacySnapshot.routeOperationalLock);
  assert.equal(legacySnapshot.routeLocalDraft, undefined);
});
