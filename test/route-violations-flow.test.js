import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeForRouteState } from '../lib/route-live-optimizer.js';
import { normalizeRouteLivePayload } from '../lib/route-live-store.js';
import { createReorderHandler } from '../lib/route-live-api.js';

// ─────────────────────────────────────────────────────────────────────────────
// Distance Matrix stub
// ─────────────────────────────────────────────────────────────────────────────

function installStub(travelMin = 20) {
  const prevFetch = global.fetch;
  const prevKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('distancematrix')) {
      const origins = u.match(/origins=([^&]+)/)[1].split('|');
      const dests = u.match(/destinations=([^&]+)/)[1].split('|');
      const rows = origins.map((o, i) => ({
        elements: dests.map((d, j) => ({
          status: 'OK',
          duration: { value: (i === j ? 0 : travelMin) * 60 },
        })),
      }));
      return { json: async () => ({ status: 'OK', rows }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => {
    global.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prevKey;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimizer: violations → violationsByContactId map
// ─────────────────────────────────────────────────────────────────────────────

test('optimizeForRouteState exposes violationsByContactId for infeasible before-constraint', async () => {
  const restore = installStub(20);
  try {
    const active = [
      {
        contactId: 'A',
        fullAddressLine: 'A',
        dayPart: 0,
        timeWindow: '09:00-13:00',
        internalFixedStart: { type: 'before', time: '09:15' },
      },
    ];
    const plan = await optimizeForRouteState({
      activeAppointments: active,
      routeState: { orderContactIds: ['A'], pinsByContactId: {} },
      preserveOrderIds: ['A'],
    });
    assert.ok(plan.violationsByContactId, 'plan bevat violationsByContactId');
    assert.equal(plan.violationsByContactId.A?.constraint, 'before');
    assert.equal(plan.violationsByContactId.A?.kind, 'internal_fixed');
    assert.equal(plan.violationsByContactId.A?.apptIdx, undefined, 'apptIdx niet gelekt in map');
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Store: normalisatie van violationsByContactId
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeRouteLivePayload keeps valid violations and drops unknown/invalid', () => {
  const out = normalizeRouteLivePayload({
    schemaVersion: 1,
    dateStr: '2026-05-20',
    routeStatus: 'live',
    orderContactIds: ['c1', 'c2'],
    violationsByContactId: {
      c1: {
        kind: 'internal_fixed',
        constraint: 'before',
        fixedTime: '09:15',
        eta: '09:30',
        finishesAt: '10:00',
        reason: 'before_deadline_exceeded',
      },
      ghost: { kind: 'time_window', eta: '13:30' }, // niet in order → drop
      c2: { kind: 'bogus' }, // ongeldige kind → drop
    },
  });
  assert.ok(out, 'payload genormaliseerd');
  assert.deepEqual(Object.keys(out.violationsByContactId), ['c1']);
  assert.equal(out.violationsByContactId.c1.constraint, 'before');
  assert.equal(out.violationsByContactId.c1.finishesAt, '10:00');
});

test('normalizeRouteLivePayload defaults violationsByContactId to empty object', () => {
  const out = normalizeRouteLivePayload({
    schemaVersion: 1,
    dateStr: '2026-05-20',
    routeStatus: 'live',
    orderContactIds: ['c1'],
  });
  assert.deepEqual(out.violationsByContactId, {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler: reorder draagt violationsByContactId door naar route-state
// ─────────────────────────────────────────────────────────────────────────────

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

test('reorder handler carries violationsByContactId from optimizer into route state', async () => {
  let routeState = {
    schemaVersion: 1,
    dateStr: '2026-05-20',
    revision: 5,
    routeStatus: 'live',
    orderContactIds: ['c1', 'c2'],
    etasByContactId: { c1: '09:00', c2: '10:00' },
    pinsByContactId: {},
    internalFixedStartByContactId: {},
  };
  const deps = {
    async loadAppointments() {
      return [
        { contactId: 'c1', status: 'ingepland', fullAddressLine: 'A 1', timeSlot: '09:00' },
        { contactId: 'c2', status: 'ingepland', fullAddressLine: 'B 2', timeSlot: '10:00' },
      ];
    },
    async ensureRouteLiveState() {
      return { ok: true, routeState, created: false };
    },
    async optimizeRoute({ appointments }) {
      return {
        orderContactIds: appointments.map((a) => a.contactId),
        etasByContactId: Object.fromEntries(appointments.map((a) => [a.contactId, '09:00'])),
        violations: [{ apptIdx: 0, kind: 'internal_fixed', constraint: 'before' }],
        violationsByContactId: {
          c2: { kind: 'internal_fixed', constraint: 'before', fixedTime: '09:15' },
        },
      };
    },
    async setRouteLiveState(_loc, _ds, payload) {
      routeState = { ...payload, revision: routeState.revision + 1 };
      return { ok: true, routeState };
    },
  };
  const handler = createReorderHandler(deps);
  const req = {
    method: 'POST',
    body: {
      locationId: 'loc-1',
      dateStr: '2026-05-20',
      orderedContactIds: ['c2', 'c1'],
      movedContactId: 'c2',
      expectedRevision: 5,
    },
    query: {},
    headers: {},
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.routeState.violationsByContactId, {
    c2: { kind: 'internal_fixed', constraint: 'before', fixedTime: '09:15' },
  });
});
