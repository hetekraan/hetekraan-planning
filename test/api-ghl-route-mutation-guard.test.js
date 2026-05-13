import test from 'node:test';
import assert from 'node:assert/strict';

function makeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body || {}),
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function loadHandler() {
  process.env.DEV_LOGIN_BYPASS = 'true';
  process.env.GHL_API_KEY = 'test-api-key';
  process.env.GHL_LOCATION_ID = 'test-location';
  process.env.GHL_CALENDAR_ID = 'test-calendar';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.GHL_FIELD_ID_PLANNER_NOTITIES = 'planner-notities-id';
  process.env.GHL_FIELD_ID_PLANNER_INTERNAL_FIXED_START = 'planner-fixed-id';
  const mod = await import(`../api/ghl.js?routeGuard=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function currentContact(overrides = {}) {
  return {
    id: 'c-1',
    address1: 'Teststraat 1, 1000 AA Amsterdam',
    customFields: [
      { id: 'C17Z7eX31XTjbSDttlaB', field_value: '2026-05-13' },
      { id: 'T69BCnexHHhco2vTKBax', field_value: '09:00–13:00' },
      { id: 'O9ZIqwzxHl60owXwddzS', field_value: 'onderhoud' },
      { id: 'AcxgtdoXkOLpvVz2SWrc', field_value: 'Teststraat 1' },
      ...(overrides.customFields || []),
    ],
    ...overrides,
  };
}

function makeRouteLock(revision = 3) {
  return {
    locked: true,
    revision,
    orderChecksum: 'abc',
    orderContactIds: ['c-1'],
    etasByContactId: { 'c-1': '09:00' },
    updatedBy: 'daan',
  };
}

function createFetchMock({ routeLocks = {}, contacts = {}, calls = [] } = {}) {
  const redisData = new Map();
  const contactById = new Map(Object.entries(contacts));

  function routeLockForKey(key) {
    const parts = String(key || '').split(':');
    const date = parts[parts.length - 1];
    if (!Object.prototype.hasOwnProperty.call(routeLocks, date)) return null;
    const lock = routeLocks[date];
    return lock == null ? null : JSON.stringify(lock);
  }

  function redisResult(command) {
    const op = String(command?.[0] || '').toLowerCase();
    const key = String(command?.[1] || '');
    if (op === 'get') {
      if (key.startsWith('hk:route_lock:')) return routeLockForKey(key);
      return redisData.get(key) || null;
    }
    if (op === 'set') {
      redisData.set(key, command[2]);
      return 'OK';
    }
    if (op === 'del') {
      redisData.delete(key);
      return 1;
    }
    if (op === 'srem' || op === 'sadd') return 1;
    return null;
  }

  return async function fetchMock(url, options = {}) {
    const u = String(url);
    const method = String(options?.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: options?.body || '' });

    if (u.startsWith('https://redis.example.test')) {
      const commands = JSON.parse(String(options?.body || '[]'));
      return makeJsonResponse(
        200,
        commands.map((command) => ({ result: redisResult(command) }))
      );
    }

    if (u.includes('/custom-fields') || u.includes('/customFields')) {
      return makeJsonResponse(200, {
        customFields: [
          { id: 'planner-notities-id', key: 'planner_notities', object: 'contact' },
          { id: 'planner-fixed-id', key: 'planner_internal_fixed_start', object: 'contact' },
        ],
      });
    }

    const contactMatch = /\/contacts\/([^/?]+)(?:$|\?)/.exec(u);
    if (contactMatch && !u.endsWith('/tags')) {
      const cid = decodeURIComponent(contactMatch[1]);
      if (method === 'GET') return makeJsonResponse(200, { contact: contactById.get(cid) || currentContact({ id: cid }) });
      if (method === 'PUT') return makeJsonResponse(200, { success: true, contact: { id: cid } });
    }

    if (u.endsWith('/contacts/upsert') && method === 'POST') {
      return makeJsonResponse(200, { contact: { id: 'c-1' } });
    }

    if (u.endsWith('/contacts/') && method === 'POST') {
      return makeJsonResponse(200, { contact: { id: 'c-1' } });
    }

    return makeJsonResponse(200, { success: true });
  };
}

async function runApi(action, body, { routeLocks, contacts, flag = 'true' } = {}) {
  const handler = await loadHandler();
  const calls = [];
  const originalFetch = global.fetch;
  const originalFlag = process.env.ROUTE_REFACTOR_ENABLED;
  global.fetch = createFetchMock({ routeLocks, contacts, calls });
  process.env.ROUTE_REFACTOR_ENABLED = flag;
  try {
    const req = {
      method: 'POST',
      query: { action },
      headers: { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000' },
      body,
    };
    const res = createMockRes();
    await handler(req, res);
    return { res, calls };
  } finally {
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.ROUTE_REFACTOR_ENABLED;
    else process.env.ROUTE_REFACTOR_ENABLED = originalFlag;
  }
}

test('createAppointment is blocked when route is centrally locked', async () => {
  const { res, calls } = await runApi(
    'createAppointment',
    {
      name: 'Klant',
      phone: '0612345678',
      address: 'Teststraat 1, Amsterdam',
      date: '2026-05-13',
      time: '09:00',
      type: 'onderhoud',
    },
    { routeLocks: { '2026-05-13': makeRouteLock() } }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ROUTE_LOCKED_MUTATION_BLOCKED');
  assert.equal(calls.some((c) => c.url.includes('services.leadconnectorhq.com')), false);
});

test('deletePlannerBooking is blocked when route is centrally locked', async () => {
  const { res } = await runApi(
    'deletePlannerBooking',
    { contactId: 'c-1', routeDate: '2026-05-13', rowId: 'hk-b1:c-1:2026-05-13' },
    { routeLocks: { '2026-05-13': makeRouteLock() } }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ROUTE_LOCKED_MUTATION_BLOCKED');
});

test('rescheduleAppointment checks both previous and new route dates', async () => {
  const { res } = await runApi(
    'rescheduleAppointment',
    {
      contactId: 'c-1',
      prevDate: '2026-05-13',
      newDate: '2026-05-14',
      newTime: '13:00',
      slotKey: 'afternoon',
      type: 'onderhoud',
    },
    { routeLocks: { '2026-05-13': makeRouteLock() } }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ROUTE_LOCKED_MUTATION_BLOCKED');
  assert.equal(res.body.currentLock.revision, 3);
});

test('setInternalFixedStart is blocked when route is centrally locked', async () => {
  const { res } = await runApi(
    'setInternalFixedStart',
    { contactId: 'c-1', routeDate: '2026-05-13', internalFixedStart: { type: 'exact', time: '10:00' } },
    { routeLocks: { '2026-05-13': makeRouteLock() } }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ROUTE_LOCKED_MUTATION_BLOCKED');
});

test('updatePlannerBookingDetails blocks changed route-impacting fields with blockedFields', async () => {
  const { res } = await runApi(
    'updatePlannerBookingDetails',
    {
      contactId: 'c-1',
      date: '2026-05-13',
      address: 'Andere Straat 99, Amsterdam',
      price: 123,
    },
    { routeLocks: { '2026-05-13': makeRouteLock() }, contacts: { 'c-1': currentContact() } }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ROUTE_LOCKED_MUTATION_BLOCKED');
  assert.deepEqual(res.body.blockedFields, ['address']);
});

test('setInternalFixedStart continues when there is no central route lock', async () => {
  const { res, calls } = await runApi(
    'setInternalFixedStart',
    { contactId: 'c-1', routeDate: '2026-05-13', internalFixedStart: { type: 'exact', time: '10:00' } },
    { routeLocks: {} }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(calls.some((c) => c.url.includes('/contacts/c-1') && c.method === 'PUT'), true);
});

test('setInternalFixedStart continues when central route lock is unlocked', async () => {
  const { res, calls } = await runApi(
    'setInternalFixedStart',
    { contactId: 'c-1', routeDate: '2026-05-13', internalFixedStart: { type: 'exact', time: '10:00' } },
    { routeLocks: { '2026-05-13': { locked: false, revision: 4, orderChecksum: null } } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(calls.some((c) => c.url.includes('/contacts/c-1') && c.method === 'PUT'), true);
});

test('updatePlannerBookingDetails allows non-route fields while route is locked', async () => {
  const { res, calls } = await runApi(
    'updatePlannerBookingDetails',
    {
      contactId: 'c-1',
      date: '2026-05-13',
      price: 123,
      plannerNotities: 'Nieuwe notitie',
      factuurType: 'particulier',
    },
    { routeLocks: { '2026-05-13': makeRouteLock() }, contacts: { 'c-1': currentContact() } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(calls.some((c) => c.url.includes('/contacts/c-1') && c.method === 'PUT'), true);
});

test('ROUTE_REFACTOR_ENABLED=false bypasses the route mutation guard', async () => {
  const { res } = await runApi(
    'deletePlannerBooking',
    { contactId: 'c-1', routeDate: '2026-05-13', rowId: 'hk-b1:c-1:2026-05-13' },
    { routeLocks: { '2026-05-13': makeRouteLock() }, flag: 'false' }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});
