import test from 'node:test';
import assert from 'node:assert/strict';

function createMockUpstashFetch() {
  const store = new Map();
  async function fetchMock(_url, init) {
    const commands = JSON.parse(String(init?.body || '[]'));
    const responses = commands.map((command) => {
      const op = String(command?.[0] || '').toLowerCase();
      if (op === 'get') return { result: store.get(command[1]) || null };
      if (op === 'set') {
        store.set(command[1], command[2]);
        return { result: 'OK' };
      }
      return { error: `unsupported ${op}` };
    });
    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return { fetchMock, store };
}

async function withMorningStore(fn) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const mock = createMockUpstashFetch();
  global.fetch = mock.fetchMock;
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  try {
    const mod = await import(`../lib/morning-message-store.js?ts=${Date.now()}-${Math.random()}`);
    return await fn(mod, mock);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

test('getMorningMessageSettings defaults enabled=true when key missing', async () => {
  await withMorningStore(async ({ getMorningMessageSettings }) => {
    const out = await getMorningMessageSettings('loc-1', '2026-05-15');
    assert.equal(out.ok, true);
    assert.equal(out.settings.enabled, true);
    assert.equal(out.settings.lastSentAt, null);
  });
});

test('setMorningMessageEnabled persists toggle', async () => {
  await withMorningStore(async ({ getMorningMessageSettings, setMorningMessageEnabled }) => {
    const off = await setMorningMessageEnabled('loc-1', '2026-05-15', false, 'daan');
    assert.equal(off.ok, true);
    assert.equal(off.settings.enabled, false);
    const read = await getMorningMessageSettings('loc-1', '2026-05-15');
    assert.equal(read.settings.enabled, false);
    const on = await setMorningMessageEnabled('loc-1', '2026-05-15', true, 'daan');
    assert.equal(on.settings.enabled, true);
  });
});

test('recordMorningMessagesSent stores revision and count', async () => {
  await withMorningStore(async ({ getMorningMessageSettings, recordMorningMessagesSent }) => {
    const out = await recordMorningMessagesSent('loc-1', '2026-05-15', {
      revision: 4,
      count: 3,
      by: 'auto_cron',
      contactIds: ['c1', 'c2', 'c3'],
      windowsByContactId: { c1: { plannedValue: '09:00' } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.settings.lastSentRevision, 4);
    assert.equal(out.settings.messageCount, 3);
    assert.equal(out.settings.lastSentBy, 'auto_cron');
    assert.ok(out.settings.lastSentAt > 0);
    const read = await getMorningMessageSettings('loc-1', '2026-05-15');
    assert.deepEqual(read.settings.lastSentContactIds, ['c1', 'c2', 'c3']);
  });
});
