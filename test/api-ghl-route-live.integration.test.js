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
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const mod = await import(`../api/ghl.js?route-live=${Date.now()}-${Math.random()}`);
  return mod.default;
}

test('getAppointments returns routeState field alongside legacy routeLock field', async () => {
  const handler = await loadHandler();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/locations/test-location/customFields')) return makeJsonResponse(200, { customFields: [] });
    if (u.includes('/calendars/events?')) return makeJsonResponse(200, { events: [] });
    if (u.includes('/calendars/blocked-slots')) return makeJsonResponse(200, { blockedSlots: [] });
    if (u.includes('/calendars/free-slots')) return makeJsonResponse(200, {});
    return makeJsonResponse(200, {});
  };

  try {
    const req = {
      method: 'GET',
      query: { action: 'getAppointments', date: '2026-05-20' },
      headers: { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000' },
      body: {},
    };
    const res = createMockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.appointments));
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'routeState'));
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'routeLock'));
  } finally {
    global.fetch = originalFetch;
  }
});
