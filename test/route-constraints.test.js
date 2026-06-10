import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectInternalFixedViolations,
  optimizeRoutePayload,
} from '../api/optimize-route.js';

// ─────────────────────────────────────────────────────────────────────────────
// collectInternalFixedViolations (puur)
// ─────────────────────────────────────────────────────────────────────────────

test('before deadline exceeded yields an internal_fixed violation', () => {
  const appts = [{ internalFixedStart: { type: 'before', time: '09:30' } }];
  // eta 09:30 (570) + job 30 = 10:00 (600) > 09:30 (570) → niet haalbaar.
  const v = collectInternalFixedViolations([0], [570], [30], appts);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'internal_fixed');
  assert.equal(v[0].constraint, 'before');
  assert.equal(v[0].reason, 'before_deadline_exceeded');
  assert.equal(v[0].fixedTime, '09:30');
  assert.equal(v[0].finishesAt, '10:00');
});

test('before deadline met yields no violation', () => {
  const appts = [{ internalFixedStart: { type: 'before', time: '11:00' } }];
  // 09:00 (540) + 30 = 09:30 ≤ 11:00 → ok.
  const v = collectInternalFixedViolations([0], [540], [30], appts);
  assert.equal(v.length, 0);
});

test('after / exact / no-pin produce no internal_fixed before-violation', () => {
  const appts = [
    { internalFixedStart: { type: 'after', time: '10:00' } },
    { internalFixedStart: { type: 'exact', time: '10:00' } },
    {},
  ];
  const v = collectInternalFixedViolations([0, 1, 2], [600, 600, 600], [30, 30, 30], appts);
  assert.equal(v.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Integratie via optimizeRoutePayload (gestubde Distance Matrix)
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

test('partitionedDay preserveOrder surfaces infeasible before-constraint as violation', async () => {
  const restore = installStub(20);
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      preserveOrder: true,
      returnToDepot: true,
      appointments: [
        {
          contactId: 'A',
          address: 'A',
          dayPart: 0,
          timeWindow: '09:00-13:00',
          jobDuration: 30,
          internalFixedStart: { type: 'before', time: '09:15' },
        },
      ],
    });
    const internal = out.violations.filter((v) => v.kind === 'internal_fixed');
    assert.equal(internal.length, 1, 'onhaalbare before geeft een internal_fixed violation');
    assert.equal(internal[0].constraint, 'before');
    assert.equal(internal[0].apptIdx, 0);
  } finally {
    restore();
  }
});

test('partitionedDay preserveOrder: feasible before-constraint yields no internal violation', async () => {
  const restore = installStub(20);
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      preserveOrder: true,
      returnToDepot: true,
      appointments: [
        {
          contactId: 'A',
          address: 'A',
          dayPart: 0,
          timeWindow: '09:00-13:00',
          jobDuration: 30,
          internalFixedStart: { type: 'before', time: '12:30' },
        },
      ],
    });
    const internal = out.violations.filter((v) => v.kind === 'internal_fixed');
    assert.equal(internal.length, 0, 'haalbare before geeft geen internal violation');
  } finally {
    restore();
  }
});
