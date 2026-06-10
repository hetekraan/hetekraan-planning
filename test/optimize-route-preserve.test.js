import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitAppointmentsByDayPart,
  computePartitionedDayWithFixedOrder,
  optimizeRoutePayload,
} from '../api/optimize-route.js';
import { optimizeForRouteState } from '../lib/route-live-optimizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// splitAppointmentsByDayPart (puur)
// ─────────────────────────────────────────────────────────────────────────────

test('splitAppointmentsByDayPart splits on numeric dayPart', () => {
  const { morningOrigIndices, afternoonOrigIndices } = splitAppointmentsByDayPart([
    { dayPart: 0 },
    { dayPart: 1 },
    { dayPart: 0 },
  ]);
  assert.deepEqual(morningOrigIndices, [0, 2]);
  assert.deepEqual(afternoonOrigIndices, [1]);
});

test('splitAppointmentsByDayPart falls back to timeWindow when dayPart absent', () => {
  // dayPart bewust weggelaten (undefined → NaN) zodat de timeWindow-fallback geldt.
  // Let op bestaand gedrag: Number(null) === 0 → dat zou juist ochtend zijn.
  const { morningOrigIndices, afternoonOrigIndices } = splitAppointmentsByDayPart([
    { timeWindow: '13:00-17:00' }, // afternoon via window
    { timeWindow: '09:00-13:00' }, // morning via window
    {}, // geen window → morning (default)
  ]);
  assert.deepEqual(morningOrigIndices, [1, 2]);
  assert.deepEqual(afternoonOrigIndices, [0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// computePartitionedDayWithFixedOrder (puur, geen netwerk)
// ─────────────────────────────────────────────────────────────────────────────

test('computePartitionedDayWithFixedOrder keeps order and maps legs from given matrix', () => {
  // travel[i][j] in minuten; index 0 = origin/depot.
  const travel = [
    [0, 10, 20],
    [10, 0, 5],
    [20, 5, 0],
  ];
  const appointments = [
    { address: 'A', timeWindow: '13:00-17:00', jobDuration: 30 },
    { address: 'B', timeWindow: '13:00-17:00', jobDuration: 30 },
  ];
  const out = computePartitionedDayWithFixedOrder({
    travel,
    appointments,
    fixedOrder: [1, 0],
    scheduleOpts: { initialClockMinutes: 13 * 60, pinFirstMorningCustomer: false },
  });

  assert.deepEqual(out.order, [1, 0], 'volgorde blijft exact fixedOrder');
  assert.equal(out.etas.length, 2);
  assert.equal(out.legInfo.length, 2);
  // Eerste been: origin(0) → appt index 1 = travel[0][2] = 20 min.
  assert.equal(out.legInfo[0].durationSeconds, 20 * 60);
  // Tweede been: vorige stop (idx1 → matrix-rij 2) → appt index 0 = travel[2][1] = 5 min.
  assert.equal(out.legInfo[1].durationSeconds, 5 * 60);
});

test('computePartitionedDayWithFixedOrder defaults to natural order when fixedOrder omitted', () => {
  const travel = [
    [0, 10, 12],
    [10, 0, 6],
    [12, 6, 0],
  ];
  const appointments = [
    { address: 'A', timeWindow: '09:00-13:00', jobDuration: 30 },
    { address: 'B', timeWindow: '09:00-13:00', jobDuration: 30 },
  ];
  const out = computePartitionedDayWithFixedOrder({
    travel,
    appointments,
    scheduleOpts: { initialClockMinutes: 9 * 60, pinFirstMorningCustomer: false },
  });
  assert.deepEqual(out.order, [0, 1]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Integratie via optimizeRoutePayload met gestubde Distance Matrix
// Bewijst: preserveOrder behoudt input-volgorde; greedy-modus herordent wél.
// ─────────────────────────────────────────────────────────────────────────────

// Reistijden (minuten) tussen depot en stops A/B/C.
// Vanaf depot is B het dichtst (10) → greedy start met B, niet met A.
const MIN = {
  DEPOT: { DEPOT: 0, A: 30, B: 10, C: 20 },
  A: { DEPOT: 30, A: 0, B: 25, C: 15 },
  B: { DEPOT: 10, A: 25, B: 0, C: 12 },
  C: { DEPOT: 20, A: 15, B: 12, C: 0 },
};

function installDistanceMatrixStub() {
  const prevFetch = global.fetch;
  const prevKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const norm = (s) => (s.includes('Dopperkade') ? 'DEPOT' : s);
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('distancematrix')) {
      const originsRaw = u.match(/origins=([^&]+)/)[1];
      const destsRaw = u.match(/destinations=([^&]+)/)[1];
      const parse = (raw) => raw.split('|').map((s) => decodeURIComponent(s));
      const origins = parse(originsRaw);
      const dests = parse(destsRaw);
      const rows = origins.map((o) => ({
        elements: dests.map((d) => ({
          status: 'OK',
          duration: { value: (MIN[norm(o)]?.[norm(d)] ?? 60) * 60 },
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

test('partitionedDay greedy reorders morning stops by travel time', async () => {
  const restore = installDistanceMatrixStub();
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      returnToDepot: true,
      appointments: [
        { contactId: 'A', address: 'A', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        { contactId: 'B', address: 'B', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        { contactId: 'C', address: 'C', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
      ],
    });
    // Greedy: depot→B(10) eerst → order begint NIET met index 0 (A).
    assert.notDeepEqual(out.order, [0, 1, 2]);
    assert.equal(out.order[0], 1, 'greedy kiest dichtstbijzijnde (B) als eerste');
  } finally {
    restore();
  }
});

test('partitionedDay preserveOrder keeps morning input order', async () => {
  const restore = installDistanceMatrixStub();
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      preserveOrder: true,
      returnToDepot: true,
      appointments: [
        { contactId: 'A', address: 'A', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        { contactId: 'B', address: 'B', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        { contactId: 'C', address: 'C', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
      ],
    });
    assert.deepEqual(out.order, [0, 1, 2], 'preserveOrder behoudt exacte input-volgorde');
    assert.equal(out.etas.length, 3);
    assert.match(out.etas[0], /^\d{2}:\d{2}$/);
  } finally {
    restore();
  }
});

test('reorder chain: optimizeForRouteState(preserveOrderIds) keeps dragged order', async () => {
  const restore = installDistanceMatrixStub();
  try {
    const active = [
      { contactId: 'A', fullAddressLine: 'A', dayPart: 0, timeWindow: '09:00-13:00' },
      { contactId: 'B', fullAddressLine: 'B', dayPart: 0, timeWindow: '09:00-13:00' },
      { contactId: 'C', fullAddressLine: 'C', dayPart: 0, timeWindow: '09:00-13:00' },
    ];
    // Gesleepte volgorde die greedy NOOIT zou maken (greedy start met B = dichtst bij depot).
    const dragged = ['C', 'A', 'B'];
    const plan = await optimizeForRouteState({
      activeAppointments: active,
      routeState: { orderContactIds: ['A', 'B', 'C'], pinsByContactId: {} },
      preserveOrderIds: dragged,
    });
    assert.deepEqual(plan.orderContactIds, dragged, 'reorder-keten behoudt gesleepte volgorde');
    assert.ok(plan.etasByContactId.C, 'ETA berekend voor eerste gesleepte stop');
  } finally {
    restore();
  }
});

test('partitionedDay preserveOrder keeps order across morning + afternoon', async () => {
  const restore = installDistanceMatrixStub();
  try {
    const out = await optimizeRoutePayload({
      mode: 'partitionedDay',
      preserveOrder: true,
      returnToDepot: true,
      appointments: [
        { contactId: 'A', address: 'A', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        { contactId: 'B', address: 'B', dayPart: 0, timeWindow: '09:00-13:00', jobDuration: 30 },
        { contactId: 'C', address: 'C', dayPart: 1, timeWindow: '13:00-17:00', jobDuration: 30 },
      ],
    });
    assert.deepEqual(out.order, [0, 1, 2], 'ochtend (A,B) en middag (C) in input-volgorde');
  } finally {
    restore();
  }
});
