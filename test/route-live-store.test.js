import test from 'node:test';
import assert from 'node:assert/strict';

function createMockUpstashFetch() {
  const store = new Map();
  const calls = [];

  function currentRevisionFromRaw(raw) {
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(String(raw));
      const revision = Number(parsed?.revision);
      return Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
    } catch {
      return 0;
    }
  }

  function evalRouteLiveCas(command) {
    const key = command[3];
    const expected = String(command[4] ?? '');
    const payload = String(command[5] ?? '');
    const raw = store.get(key) || null;
    const currentRevision = currentRevisionFromRaw(raw);

    if (raw && expected === '') {
      return [0, 'EXPECTED_REVISION_REQUIRED', currentRevision, raw];
    }

    if (expected !== '') {
      const expectedNumber = Number(expected);
      if (!Number.isFinite(expectedNumber) || Math.floor(expectedNumber) !== currentRevision) {
        return [0, 'REVISION_CONFLICT', currentRevision, raw || ''];
      }
    }

    let nextRoute;
    try {
      nextRoute = JSON.parse(payload);
    } catch {
      return [0, 'BAD_PAYLOAD_JSON', currentRevision, raw || ''];
    }

    nextRoute.revision = currentRevision + 1;
    const encoded = JSON.stringify(nextRoute);
    store.set(key, encoded);
    return [1, 'OK', nextRoute.revision, encoded];
  }

  async function fetchMock(_url, init) {
    const commands = JSON.parse(String(init?.body || '[]'));
    const responses = commands.map((command) => {
      calls.push(command);
      const op = String(command?.[0] || '').toLowerCase();
      if (op === 'get') {
        return { result: store.get(command[1]) || null };
      }
      if (op === 'set') {
        store.set(command[1], command[2]);
        return { result: 'OK' };
      }
      if (op === 'eval') {
        return { result: evalRouteLiveCas(command) };
      }
      return { error: `unsupported command ${op}` };
    });
    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return { fetchMock, store, calls };
}

async function withRouteLiveStore(fn) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const mock = createMockUpstashFetch();

  global.fetch = mock.fetchMock;
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  try {
    const mod = await import(`../lib/route-live-store.js?ts=${Date.now()}-${Math.random()}`);
    return await fn(mod, mock);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

function routeLivePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    dateStr: '2026-05-20',
    routeStatus: 'live',
    orderContactIds: ['contact-1', 'contact-2'],
    etasByContactId: {
      'contact-1': '09:00',
      'contact-2': '10:00',
    },
    pinsByContactId: {
      'contact-2': {
        type: 'manual_order',
        anchor: 'after:contact-1',
        createdAt: 1760000000000,
        createdBy: 'daan',
      },
    },
    internalFixedStartByContactId: {
      'contact-1': { type: 'exact', time: '09:00' },
    },
    lastOptimizedAt: 1760000000000,
    lastRouteInputChangedAt: 1760000000000,
    routeInputFingerprint: 'fingerprint-1',
    optimizerVersion: 'partitioned-day-v1',
    updatedAt: 1760000000000,
    updatedBy: 'test-user',
    source: 'manual_reorder',
    ...overrides,
  };
}

test('route live CAS allows first write without expectedRevision', async () => {
  await withRouteLiveStore(async (mod) => {
    const first = await mod.setRouteLiveState('loc-1', '2026-05-20', routeLivePayload());
    assert.equal(first.ok, true);
    assert.equal(first.routeState.revision, 1);
    assert.equal(first.routeState.schemaVersion, 1);
    assert.equal(first.routeState.routeStatus, 'live');
  });
});

test('route live CAS requires expectedRevision after first write', async () => {
  await withRouteLiveStore(async (mod) => {
    const first = await mod.setRouteLiveState('loc-1', '2026-05-20', routeLivePayload());
    assert.equal(first.ok, true);

    const missingExpected = await mod.setRouteLiveState(
      'loc-1',
      '2026-05-20',
      routeLivePayload({ orderContactIds: ['contact-2', 'contact-1'] })
    );
    assert.equal(missingExpected.ok, false);
    assert.equal(missingExpected.code, 'EXPECTED_REVISION_REQUIRED');
    assert.equal(missingExpected.currentRoute.revision, 1);
  });
});

test('route live CAS accepts correct expectedRevision', async () => {
  await withRouteLiveStore(async (mod) => {
    await mod.setRouteLiveState('loc-1', '2026-05-20', routeLivePayload());
    const update = await mod.setRouteLiveState(
      'loc-1',
      '2026-05-20',
      routeLivePayload({ expectedRevision: 1, orderContactIds: ['contact-2', 'contact-1'] })
    );
    assert.equal(update.ok, true);
    assert.equal(update.routeState.revision, 2);
    assert.deepEqual(update.routeState.orderContactIds, ['contact-2', 'contact-1']);
  });
});

test('route live CAS rejects stale expectedRevision', async () => {
  await withRouteLiveStore(async (mod) => {
    await mod.setRouteLiveState('loc-1', '2026-05-20', routeLivePayload());
    const stale = await mod.setRouteLiveState(
      'loc-1',
      '2026-05-20',
      routeLivePayload({ expectedRevision: 0, orderContactIds: ['contact-2', 'contact-1'] })
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(stale.currentRoute.revision, 1);
  });
});

test('route live payload validation rejects bad schema and bad date', async () => {
  await withRouteLiveStore(async (mod) => {
    const badSchema = await mod.setRouteLiveState(
      'loc-1',
      '2026-05-20',
      routeLivePayload({ schemaVersion: 2 })
    );
    assert.equal(badSchema.ok, false);
    assert.equal(badSchema.code, 'BAD_PAYLOAD');

    const badDate = await mod.setRouteLiveState('loc-1', 'not-a-date', routeLivePayload());
    assert.equal(badDate.ok, false);
    assert.equal(badDate.code, 'BAD_DATE');
  });
});

test('ensureRouteLiveState migrates existing locked route lock', async () => {
  await withRouteLiveStore(async (mod, mock) => {
    mock.store.set(
      'hk:route_lock:loc-1:2026-05-20',
      JSON.stringify({
        locked: true,
        revision: 4,
        orderContactIds: ['contact-2', 'contact-1'],
        etasByContactId: { 'contact-2': '09:00', 'contact-1': '10:00' },
        updatedBy: 'jerry',
      })
    );

    const out = await mod.ensureRouteLiveState('loc-1', '2026-05-20', [
      { contactId: 'contact-1', status: 'ingepland', timeSlot: '10:00' },
      { contactId: 'contact-2', status: 'ingepland', timeSlot: '09:00' },
    ]);

    assert.equal(out.ok, true);
    assert.equal(out.created, true);
    assert.equal(out.migratedFromLegacy, true);
    assert.equal(out.routeState.source, 'migrated_route_lock');
    assert.deepEqual(out.routeState.orderContactIds, ['contact-2', 'contact-1']);
    assert.equal(out.routeState.revision, 1);
  });
});

test('ensureRouteLiveState initializes from non-klaar appointments', async () => {
  await withRouteLiveStore(async (mod) => {
    const out = await mod.ensureRouteLiveState('loc-1', '2026-05-20', [
      { contactId: 'contact-1', status: 'klaar', timeSlot: '09:00' },
      { contactId: 'contact-2', status: 'onderweg', timeSlot: '10:00' },
      {
        contactId: 'contact-3',
        status: 'ingepland',
        timeSlot: '11:00',
        internalFixedStartTime: '11:00',
      },
      { contactId: 'block-1', isCalBlock: true, status: 'ingepland', timeSlot: '12:00' },
    ]);

    assert.equal(out.ok, true);
    assert.equal(out.created, true);
    assert.equal(out.migratedFromLegacy, false);
    assert.equal(out.routeState.source, 'initialized_from_appointments');
    assert.deepEqual(out.routeState.orderContactIds, ['contact-2', 'contact-3']);
    assert.deepEqual(out.routeState.etasByContactId, {
      'contact-2': '10:00',
      'contact-3': '11:00',
    });
    assert.deepEqual(out.routeState.internalFixedStartByContactId, {
      'contact-3': { type: 'exact', time: '11:00' },
    });
  });
});

test('ensureRouteLiveState returns existing live route without rewriting', async () => {
  await withRouteLiveStore(async (mod, mock) => {
    const first = await mod.ensureRouteLiveState('loc-1', '2026-05-20', [
      { contactId: 'contact-1', status: 'ingepland', timeSlot: '09:00' },
    ]);
    assert.equal(first.ok, true);
    const callsAfterFirst = mock.calls.length;

    const second = await mod.ensureRouteLiveState('loc-1', '2026-05-20', []);
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.routeState.revision, first.routeState.revision);
    assert.ok(mock.calls.length < callsAfterFirst + 3);
  });
});
