import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOptimizeHandler,
  createReorderHandler,
  createUnpinHandler,
} from '../lib/route-live-api.js';

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function liveRoute(overrides = {}) {
  return {
    schemaVersion: 1,
    dateStr: '2026-05-20',
    revision: 5,
    routeStatus: 'live',
    orderContactIds: ['c1', 'c2', 'c3'],
    etasByContactId: { c1: '09:00', c2: '10:00', c3: '11:00' },
    pinsByContactId: {},
    internalFixedStartByContactId: {},
    lastOptimizedAt: 1760000000000,
    lastRouteInputChangedAt: 1760000000000,
    routeInputFingerprint: 'fingerprint-1',
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
    { contactId: 'c1', status: 'ingepland', fullAddressLine: 'A straat 1', timeSlot: '09:00', jobType: 'reparatie' },
    { contactId: 'c2', status: 'onderweg', fullAddressLine: 'B straat 2', timeSlot: '10:00', jobType: 'onderhoud' },
    { contactId: 'c3', status: 'ingepland', fullAddressLine: 'C straat 3', timeSlot: '11:00', jobType: 'installatie' },
    { contactId: 'done', status: 'klaar', fullAddressLine: 'D straat 4', timeSlot: '12:00', jobType: 'reparatie' },
  ];
}

function createDeps(initialRoute = liveRoute(), rows = appointments()) {
  const calls = { optimize: [], set: [] };
  let routeState = initialRoute;
  return {
    calls,
    async loadAppointments() {
      return rows;
    },
    async ensureRouteLiveState() {
      return { ok: true, routeState, created: false, migratedFromLegacy: false };
    },
    async optimizeRoute({ appointments: inputAppointments }) {
      calls.optimize.push(inputAppointments);
      return {
        orderContactIds: inputAppointments.map((a) => a.contactId),
        etasByContactId: Object.fromEntries(
          inputAppointments.map((a, idx) => [a.contactId, `${String(9 + idx).padStart(2, '0')}:00`])
        ),
        violations: [],
      };
    },
    async setRouteLiveState(_locationId, _dateStr, payload) {
      calls.set.push(payload);
      if (payload.expectedRevision === 999) {
        return { ok: false, code: 'REVISION_CONFLICT', currentRoute: routeState };
      }
      if (payload.expectedRevision === 998) {
        return { ok: false, code: 'EXPECTED_REVISION_REQUIRED', currentRoute: routeState };
      }
      routeState = { ...payload, revision: routeState.revision + 1 };
      return { ok: true, routeState };
    },
  };
}

async function run(handler, body, method = 'POST') {
  const req = { method, body, query: {}, headers: {} };
  const res = makeRes();
  await handler(req, res);
  return res;
}

test('reorder writes manual pin and returns route state', async () => {
  const deps = createDeps();
  const handler = createReorderHandler(deps);
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    orderedContactIds: ['c1', 'c3', 'c2'],
    movedContactId: 'c2',
    pin: true,
    expectedRevision: 5,
    updatedBy: 'daan',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.routeState.orderContactIds, ['c1', 'c3', 'c2']);
  assert.deepEqual(res.body.routeState.pinsByContactId.c2, {
    type: 'manual_order',
    anchor: 'after:c3',
    createdAt: res.body.routeState.pinsByContactId.c2.createdAt,
    createdBy: 'daan',
  });
  assert.equal(deps.calls.set[0].source, 'manual_reorder');
});

test('reorder rejects missing locationId', async () => {
  const handler = createReorderHandler(createDeps());
  const res = await run(handler, {
    dateStr: '2026-05-20',
    orderedContactIds: ['c1'],
    movedContactId: 'c1',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'LOCATION_ID_REQUIRED');
});

test('reorder rejects invalid dateStr', async () => {
  const handler = createReorderHandler(createDeps());
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '20-05-2026',
    orderedContactIds: ['c1'],
    movedContactId: 'c1',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_DATE');
});

test('reorder returns 409 with currentRouteState on revision conflict', async () => {
  const handler = createReorderHandler(createDeps());
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    orderedContactIds: ['c1', 'c2', 'c3'],
    movedContactId: 'c2',
    expectedRevision: 999,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'REVISION_CONFLICT');
  assert.equal(res.body.currentRouteState.revision, 5);
});

test('reorder rejects stale contactId in orderedContactIds', async () => {
  const handler = createReorderHandler(createDeps());
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    orderedContactIds: ['c1', 'ghost', 'c2'],
    movedContactId: 'c2',
    expectedRevision: 5,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'STALE_CONTACT_ID');
  assert.deepEqual(res.body.staleContactIds, ['ghost']);
});

test('unpin removes pin and is idempotent', async () => {
  const deps = createDeps(liveRoute({ pinsByContactId: { c2: { type: 'manual_order', anchor: 'after:c1' } } }));
  const handler = createUnpinHandler(deps);
  const body = {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    contactId: 'c2',
    expectedRevision: 5,
    updatedBy: 'daan',
  };

  const first = await run(handler, body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.ok, true);
  assert.deepEqual(first.body.routeState.pinsByContactId, {});

  const second = await run(handler, { ...body, expectedRevision: first.body.routeState.revision });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.noop, true);
});

test('unpin rejects missing contactId', async () => {
  const handler = createUnpinHandler(createDeps());
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    expectedRevision: 5,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'CONTACT_ID_REQUIRED');
});

test('unpin returns 409 with currentRouteState when expected revision is required', async () => {
  const deps = createDeps(liveRoute({ pinsByContactId: { c2: { type: 'manual_order', anchor: 'after:c1' } } }));
  const handler = createUnpinHandler(deps);
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    contactId: 'c2',
    expectedRevision: 998,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'EXPECTED_REVISION_REQUIRED');
  assert.equal(res.body.currentRouteState.revision, 5);
});

test('optimize rejects invalid dateStr', async () => {
  const handler = createOptimizeHandler(createDeps());
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '20260520',
    expectedRevision: 5,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'BAD_DATE');
});

test('optimize writes manual optimize route state', async () => {
  const deps = createDeps();
  const handler = createOptimizeHandler(deps);
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    expectedRevision: 5,
    updatedBy: 'daan',
    reason: 'manual_button',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.routeState.source, 'manual_optimize');
  assert.deepEqual(res.body.routeState.orderContactIds, ['c1', 'c2', 'c3']);
});

test('optimize returns 409 with currentRouteState on revision conflict', async () => {
  const handler = createOptimizeHandler(createDeps());
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    expectedRevision: 999,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'REVISION_CONFLICT');
  assert.equal(res.body.currentRouteState.revision, 5);
});

test('optimize excludes klaar appointments from new ETA calculation', async () => {
  const deps = createDeps();
  const handler = createOptimizeHandler(deps);
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    expectedRevision: 5,
    reason: 'auto_appointment_mutation',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.routeState.source, 'auto_optimize');
  assert.deepEqual(
    deps.calls.optimize[0].map((a) => a.contactId),
    ['c1', 'c2', 'c3']
  );
});

test('optimize returns 500 and keeps route unchanged on optimize failure', async () => {
  const deps = createDeps();
  deps.optimizeRoute = async () => {
    throw new Error('maps failed');
  };
  const handler = createOptimizeHandler(deps);
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    expectedRevision: 5,
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'OPTIMIZE_FAILED');
  assert.equal(deps.calls.set.length, 0);
});

test('optimize returns ROUTE_LIVE_INIT_FAILED when live-state init throws', async () => {
  const deps = createDeps();
  deps.ensureRouteLiveState = async () => {
    throw new Error('redis unavailable');
  };
  const handler = createOptimizeHandler(deps);
  const res = await run(handler, {
    locationId: 'loc-1',
    dateStr: '2026-05-20',
    expectedRevision: 5,
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'ROUTE_LIVE_INIT_FAILED');
  assert.equal(deps.calls.set.length, 0);
});
