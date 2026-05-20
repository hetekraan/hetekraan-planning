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

function makeTextResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => String(text || ''),
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
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
      this.ended = true;
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
  const mod = await import(`../api/ghl.js?it=${Date.now()}-${Math.random()}`);
  return mod.default;
}

async function runCompleteAppointmentScenario({ sendReview, contactFetch, expectReviewTagPost }) {
  const handler = await loadHandler();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const method = String(options?.method || 'GET').toUpperCase();
    const u = String(url);
    calls.push({ url: u, method, body: options?.body });

    if (u.endsWith('/contacts/c-1') && method === 'PUT') {
      return makeJsonResponse(200, { success: true });
    }
    if (u.endsWith('/contacts/c-1/tags') && method === 'POST') {
      const payload = JSON.parse(String(options?.body || '{}'));
      const tags = Array.isArray(payload?.tags) ? payload.tags : [];
      if (tags.includes('factuur-versturen')) return makeJsonResponse(200, { success: true });
      if (tags.includes('review_mail_versturen')) return makeJsonResponse(200, { success: true });
      return makeJsonResponse(400, { error: 'unknown tag payload' });
    }
    if (u.endsWith('/contacts/c-1') && method === 'GET') {
      return contactFetch();
    }
    if (u.includes('/locations/test-location/customFields') && method === 'GET') {
      return makeJsonResponse(200, { customFields: [] });
    }
    if (u.includes('/calendars/events?') && method === 'GET') {
      return makeJsonResponse(200, { events: [] });
    }
    if (u.includes('/calendars/blocked-slots') && method === 'GET') {
      return makeJsonResponse(200, { blockedSlots: [] });
    }
    if (u.includes('/calendars/free-slots') && method === 'GET') {
      return makeJsonResponse(200, {});
    }
    return makeTextResponse(500, `unexpected fetch ${method} ${u}`);
  };

  try {
    const req = {
      method: 'POST',
      query: { action: 'completeAppointment' },
      headers: { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000' },
      body: {
        contactId: 'c-1',
        type: 'onderhoud',
        sendReview,
        routeDate: '2026-04-22',
        lastService: '2026-04-22',
        totalPrice: 0,
        extras: [],
      },
    };
    const res = createMockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(Boolean(res.body?.success), true);
    assert.ok(res.body && Object.prototype.hasOwnProperty.call(res.body, 'reviewAutomation'));

    const postedTagNames = [];
    for (const c of calls) {
      if (!c.url.endsWith('/contacts/c-1/tags') || c.method !== 'POST') continue;
      try {
        const payload = JSON.parse(String(c.body || '{}'));
        const tags = Array.isArray(payload?.tags) ? payload.tags : [];
        postedTagNames.push(...tags);
      } catch {
        /* ignore */
      }
    }
    const reviewTagPosted = postedTagNames.includes('review_mail_versturen');
    assert.equal(reviewTagPosted, expectReviewTagPost);

    const factuurTagPosted = postedTagNames.includes('factuur-versturen');
    assert.equal(factuurTagPosted, false);

    return { body: res.body, calls };
  } finally {
    global.fetch = originalFetch;
  }
}

test('completeAppointment returns reviewAutomation across integration paths', async () => {
  const notMet = await runCompleteAppointmentScenario({
    sendReview: false,
    contactFetch: () => makeJsonResponse(200, { contact: { id: 'c-1', tags: [] } }),
    expectReviewTagPost: false,
  });
  assert.equal(notMet.body.reviewAutomation.reason, 'conditions_not_met');

  const tagAdded = await runCompleteAppointmentScenario({
    sendReview: true,
    contactFetch: () => makeJsonResponse(200, { contact: { id: 'c-1', tags: ['factuur-versturen'] } }),
    expectReviewTagPost: true,
  });
  assert.equal(tagAdded.body.reviewAutomation.reason, 'tag_added');
  assert.equal(tagAdded.body.reviewAutomation.tagAdded, true);

  const tagExists = await runCompleteAppointmentScenario({
    sendReview: true,
    contactFetch: () => makeJsonResponse(200, { contact: { id: 'c-1', tags: ['review_mail_versturen'] } }),
    expectReviewTagPost: false,
  });
  assert.equal(tagExists.body.reviewAutomation.reason, 'tag_already_exists');
  assert.equal(tagExists.body.reviewAutomation.repeatCompletion, true);

  const contactMissing = await runCompleteAppointmentScenario({
    sendReview: true,
    contactFetch: () => makeTextResponse(404, 'not found'),
    expectReviewTagPost: false,
  });
  assert.equal(contactMissing.body.reviewAutomation.reason, 'contact_not_found');
  assert.equal(contactMissing.body.reviewAutomation.tagAdded, false);
});
