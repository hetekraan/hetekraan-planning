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

// ── after_forced_wait ────────────────────────────────────────────────────────

test('after forced wait (60 min) yields an after violation', () => {
  const appts = [{ internalFixedStart: { type: 'after', time: '15:00' } }]; // T = 900
  // earliest 14:00 (840), eta clamped naar 15:00 (900). wait = 60 >= 15 → violation.
  const meta = [{ earliest: 840, appliedEta: 900, pinType: 'after', exactReachable: null }];
  const v = collectInternalFixedViolations([0], [900], [30], appts, meta);
  assert.equal(v.length, 1);
  assert.equal(v[0].constraint, 'after');
  assert.equal(v[0].reason, 'after_forced_wait');
  assert.equal(v[0].waitMinutes, 60);
  assert.equal(v[0].earliest, '14:00');
  assert.equal(v[0].fixedTime, '15:00');
});

test('after small wait (10 min) yields no violation (below threshold)', () => {
  const appts = [{ internalFixedStart: { type: 'after', time: '15:00' } }]; // T = 900
  const meta = [{ earliest: 890, appliedEta: 900, pinType: 'after', exactReachable: null }]; // wait 10
  const v = collectInternalFixedViolations([0], [900], [30], appts, meta);
  assert.equal(v.length, 0);
});

test('after wait exactly at threshold (15 min) yields a violation', () => {
  const appts = [{ internalFixedStart: { type: 'after', time: '15:00' } }]; // T = 900
  const meta = [{ earliest: 885, appliedEta: 900, pinType: 'after', exactReachable: null }]; // wait 15
  const v = collectInternalFixedViolations([0], [900], [30], appts, meta);
  assert.equal(v.length, 1);
  assert.equal(v[0].waitMinutes, 15);
});

test('after without scheduleMeta produces no violation (graceful)', () => {
  const appts = [{ internalFixedStart: { type: 'after', time: '15:00' } }];
  const v = collectInternalFixedViolations([0], [900], [30], appts);
  assert.equal(v.length, 0);
});

// ── exact_not_reachable ──────────────────────────────────────────────────────

test('exact not reachable yields an exact violation', () => {
  const appts = [{ internalFixedStart: { type: 'exact', time: '10:00' } }]; // T = 600
  // earliest 10:30 (630) > T, exactReachable false (step > 0).
  const meta = [{ earliest: 630, appliedEta: 600, pinType: 'exact', exactReachable: false }];
  const v = collectInternalFixedViolations([0], [600], [30], appts, meta);
  assert.equal(v.length, 1);
  assert.equal(v[0].constraint, 'exact');
  assert.equal(v[0].reason, 'exact_not_reachable');
  assert.equal(v[0].fixedTime, '10:00');
  assert.equal(v[0].earliest, '10:30');
});

test('exact reachable (step 0 backward departure) yields no violation', () => {
  const appts = [{ internalFixedStart: { type: 'exact', time: '10:00' } }];
  // earliest > T maar exactReachable true → haalbaar door eerder te vertrekken.
  const meta = [{ earliest: 630, appliedEta: 600, pinType: 'exact', exactReachable: true }];
  const v = collectInternalFixedViolations([0], [600], [30], appts, meta);
  assert.equal(v.length, 0);
});

test('combined before + after + exact in one route', () => {
  const appts = [
    { internalFixedStart: { type: 'before', time: '09:30' } }, // eta+job > T → before
    { internalFixedStart: { type: 'after', time: '15:00' } }, // wait 60 → after
    { internalFixedStart: { type: 'exact', time: '11:00' } }, // unreachable → exact
  ];
  const etas = [570, 900, 660]; // before eta 09:30; after 15:00; exact 11:00
  const jobs = [30, 30, 30];
  const meta = [
    { earliest: 570, appliedEta: 570, pinType: 'before', exactReachable: null },
    { earliest: 840, appliedEta: 900, pinType: 'after', exactReachable: null },
    { earliest: 690, appliedEta: 660, pinType: 'exact', exactReachable: false },
  ];
  const v = collectInternalFixedViolations([0, 1, 2], etas, jobs, appts, meta);
  assert.deepEqual(
    v.map((x) => x.constraint).sort(),
    ['after', 'before', 'exact']
  );
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

test('partitionedDay preserveOrder surfaces after forced-wait as violation', async () => {
  const restore = installStub(20);
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      preserveOrder: true,
      returnToDepot: true,
      appointments: [
        {
          contactId: 'M',
          address: 'M',
          dayPart: 1,
          timeWindow: '13:00-17:00',
          jobDuration: 30,
          internalFixedStart: { type: 'after', time: '15:00' },
        },
      ],
    });
    const internal = out.violations.filter((v) => v.kind === 'internal_fixed');
    assert.equal(internal.length, 1, 'after met grote wachttijd geeft violation');
    assert.equal(internal[0].constraint, 'after');
    assert.equal(internal[0].reason, 'after_forced_wait');
    assert.ok(internal[0].waitMinutes >= 15);
  } finally {
    restore();
  }
});

test('partitionedDay preserveOrder surfaces exact_not_reachable for later stop', async () => {
  const restore = installStub(20);
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      preserveOrder: true,
      returnToDepot: true,
      appointments: [
        { contactId: 'A', address: 'A', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        {
          contactId: 'B',
          address: 'B',
          dayPart: 0,
          timeWindow: '09:00-13:00',
          jobDuration: 30,
          internalFixedStart: { type: 'exact', time: '09:10' }, // te vroeg na A
        },
      ],
    });
    const internal = out.violations.filter((v) => v.kind === 'internal_fixed');
    assert.equal(internal.length, 1, 'onhaalbare exact op latere positie geeft violation');
    assert.equal(internal[0].constraint, 'exact');
    assert.equal(internal[0].reason, 'exact_not_reachable');
  } finally {
    restore();
  }
});

test('partitionedDay preserveOrder: exact on first stop is reachable (no violation)', async () => {
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
          internalFixedStart: { type: 'exact', time: '09:00' }, // haalbaar door eerder te vertrekken
        },
      ],
    });
    const internal = out.violations.filter((v) => v.kind === 'internal_fixed');
    assert.equal(internal.length, 0, 'exact op eerste stop blijft haalbaar via vroeger vertrek');
  } finally {
    restore();
  }
});
