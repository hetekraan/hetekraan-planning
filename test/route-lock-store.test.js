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

  function evalRouteLockCas(command) {
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

    let nextLock;
    try {
      nextLock = JSON.parse(payload);
    } catch {
      return [0, 'BAD_PAYLOAD_JSON', currentRevision, raw || ''];
    }

    nextLock.revision = currentRevision + 1;
    const encoded = JSON.stringify(nextLock);
    store.set(key, encoded);
    return [1, 'OK', nextLock.revision, encoded];
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
        return { result: evalRouteLockCas(command) };
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

function routeLockPayload(overrides = {}) {
  return {
    dateStr: '2026-05-13',
    locked: true,
    orderContactIds: ['contact-1', 'contact-2'],
    etasByContactId: {
      'contact-1': '09:00',
      'contact-2': '10:00',
    },
    updatedBy: 'test-user',
    ...overrides,
  };
}

async function runRevisionScenario(mode) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalFlag = process.env.ROUTE_REFACTOR_ENABLED;
  const originalWarn = console.warn;
  const mock = createMockUpstashFetch();

  global.fetch = mock.fetchMock;
  console.warn = () => {};
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.ROUTE_REFACTOR_ENABLED = mode === 'legacy' ? 'false' : 'true';

  try {
    const mod = await import(`../lib/route-lock-store.js?mode=${mode}&ts=${Date.now()}-${Math.random()}`);

    const first = await mod.setRouteLock('loc-1', '2026-05-13', routeLockPayload());
    assert.equal(first.ok, true);
    assert.equal(first.lock.revision, 1);

    const missingExpected = await mod.setRouteLock('loc-1', '2026-05-13', routeLockPayload());
    assert.equal(missingExpected.ok, false);
    assert.equal(missingExpected.code, 'EXPECTED_REVISION_REQUIRED');
    assert.equal(missingExpected.currentLock.revision, 1);

    const correctExpected = await mod.setRouteLock(
      'loc-1',
      '2026-05-13',
      routeLockPayload({ expectedRevision: 1, orderContactIds: ['contact-2', 'contact-1'] })
    );
    assert.equal(correctExpected.ok, true);
    assert.equal(correctExpected.lock.revision, 2);

    const wrongExpected = await mod.setRouteLock(
      'loc-1',
      '2026-05-13',
      routeLockPayload({ expectedRevision: 0, orderContactIds: ['contact-1'] })
    );
    assert.equal(wrongExpected.ok, false);
    assert.equal(wrongExpected.code, 'REVISION_CONFLICT');
    assert.equal(wrongExpected.currentLock.revision, 2);

    const usedEval = mock.calls.some((command) => String(command?.[0] || '').toLowerCase() === 'eval');
    assert.equal(usedEval, mode === 'cas');
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    if (originalFlag === undefined) delete process.env.ROUTE_REFACTOR_ENABLED;
    else process.env.ROUTE_REFACTOR_ENABLED = originalFlag;
  }
}

test('route lock CAS requires expectedRevision after first write', async () => {
  await runRevisionScenario('cas');
});

test('route lock legacy mode matches expectedRevision semantics', async () => {
  await runRevisionScenario('legacy');
});
