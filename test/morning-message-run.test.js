import test from 'node:test';
import assert from 'node:assert/strict';
import { isWeekendDateStr } from '../lib/morning-message-run.js';

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
    return await fn(mod);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

test('isWeekendDateStr detects Saturday and Sunday in Amsterdam', () => {
  assert.equal(isWeekendDateStr('2026-05-16'), true);
  assert.equal(isWeekendDateStr('2026-05-17'), true);
  assert.equal(isWeekendDateStr('2026-05-15'), false);
});

test('runMorningMessagesForDay skips disabled days', async () => {
  await withMorningStore(async ({ setMorningMessageEnabled }) => {
    await setMorningMessageEnabled('loc-1', '2026-05-15', false, 'test');
    const { runMorningMessagesForDay } = await import(
      `../lib/morning-message-run.js?ts=${Date.now()}-${Math.random()}`
    );
    const out = await runMorningMessagesForDay({
      locationId: 'loc-1',
      dateStr: '2026-05-15',
      by: 'auto_cron',
      skipIfAlreadySent: true,
      loadAppointmentsForDate: async () => ({
        appointments: [{ contactId: 'c1', status: 'ingepland' }],
      }),
      sendDeps: { apiKey: 'k', geplandeAankomstFieldId: 'f' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.skipped, true);
    assert.equal(out.code, 'DISABLED');
  });
});

test('runMorningMessagesForDay skips when no ingepland appointments', async () => {
  const { runMorningMessagesForDay } = await import('../lib/morning-message-run.js');
  const out = await runMorningMessagesForDay({
    locationId: 'loc-1',
    dateStr: '2026-05-15',
    by: 'auto_cron',
    skipEnabledCheck: true,
    loadAppointmentsForDate: async () => ({
      appointments: [{ contactId: 'c1', status: 'klaar' }],
    }),
    sendDeps: { apiKey: 'k', geplandeAankomstFieldId: 'f' },
  });
  assert.equal(out.skipped, true);
  assert.equal(out.code, 'NO_INGEPLAND');
});
