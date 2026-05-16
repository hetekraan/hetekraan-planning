import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNextEtaPreviewHandler,
  createSendNextEtaHandler,
} from '../lib/route-next-eta-api.js';

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function liveRoute(overrides = {}) {
  return {
    schemaVersion: 1,
    dateStr: '2026-05-20',
    revision: 3,
    routeStatus: 'live',
    orderContactIds: ['c1', 'c2'],
    etasByContactId: { c1: '09:00', c2: '10:30' },
    pinsByContactId: {},
    internalFixedStartByContactId: {},
    etaSentByContactId: {},
    lastOptimizedAt: 1,
    lastRouteInputChangedAt: 1,
    routeInputFingerprint: 'fp',
    optimizerVersion: 'v1',
    updatedAt: 1,
    updatedBy: 'test',
    source: 'test',
    migratedFromLegacy: false,
    ...overrides,
  };
}

const rows = [
  { contactId: 'c1', status: 'klaar', fullAddressLine: 'A 1', name: 'A' },
  { contactId: 'c2', status: 'ingepland', fullAddressLine: 'B 2', name: 'B' },
];

function deps(routeState = liveRoute()) {
  let state = routeState;
  return {
    async loadAndEnsureRouteState() {
      return { ok: true, appointments: rows, routeState: state };
    },
    async setRouteLiveState(_loc, _date, payload) {
      state = {
        ...state,
        ...payload,
        revision: state.revision + 1,
        etaSentByContactId: payload.etaSentByContactId || state.etaSentByContactId,
      };
      return { ok: true, routeState: state };
    },
    buildNextEtaPreview: async () => ({
      ok: true,
      nextContact: { id: 'c2', name: 'B', address: 'B 2' },
      etaTime: '10:45',
    }),
    resolveSendNextEta: async () => ({
      ok: true,
      sentEta: '10:45',
      nextContact: { id: 'c2', name: 'B' },
    }),
    sendGeplandeAankomstEtaToContact: async () => ({ ok: true, workflowTag: 'monteur-eta' }),
    ghlApiKey: () => 'test-key',
    geplandeAankomstFieldId: () => 'field-eta',
    mapsKey: () => 'maps-key',
  };
}

test('next-eta-preview happy path', async () => {
  const handler = createNextEtaPreviewHandler(deps());
  const res = makeRes();
  await handler(
    {
      method: 'GET',
      query: {
        locationId: 'loc1',
        dateStr: '2026-05-20',
        currentContactId: 'c1',
      },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.nextContact.id, 'c2');
  assert.equal(res.body.etaTime, '10:45');
});

test('send-next-eta happy path', async () => {
  const handler = createSendNextEtaHandler(deps());
  const res = makeRes();
  await handler(
    {
      method: 'POST',
      body: {
        locationId: 'loc1',
        dateStr: '2026-05-20',
        expectedRevision: 3,
        currentContactId: 'c1',
        nextContactId: 'c2',
        eta: '10:45',
      },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sentEta, '10:45');
  assert.equal(res.body.routeState.etaSentByContactId.c2.eta, '10:45');
});

test('send-next-eta preserves orderContactIds', async () => {
  const initialOrder = ['c1', 'c2', 'c3'];
  const handler = createSendNextEtaHandler(
    deps(
      liveRoute({
        orderContactIds: initialOrder,
        etasByContactId: { c1: '09:00', c2: '10:30', c3: '14:00' },
      })
    )
  );
  const res = makeRes();
  await handler(
    {
      method: 'POST',
      body: {
        locationId: 'loc1',
        dateStr: '2026-05-20',
        expectedRevision: 3,
        currentContactId: 'c2',
        nextContactId: 'c3',
        eta: '08:15',
      },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.routeState.orderContactIds, initialOrder);
});

test('send-next-eta stale contact', async () => {
  const handler = createSendNextEtaHandler({
    ...deps(),
    resolveSendNextEta: async () => ({ ok: false, code: 'STALE_CONTACT_ID' }),
  });
  const res = makeRes();
  await handler(
    {
      method: 'POST',
      body: {
        locationId: 'loc1',
        dateStr: '2026-05-20',
        expectedRevision: 3,
        currentContactId: 'c1',
        nextContactId: 'gone',
        eta: '10:00',
      },
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'STALE_CONTACT_ID');
});

test('send-next-eta GHL failure', async () => {
  const handler = createSendNextEtaHandler({
    ...deps(),
    sendGeplandeAankomstEtaToContact: async () => ({ ok: false, code: 'GHL_PUT_FAILED' }),
  });
  const res = makeRes();
  await handler(
    {
      method: 'POST',
      body: {
        locationId: 'loc1',
        dateStr: '2026-05-20',
        expectedRevision: 3,
        currentContactId: 'c1',
        nextContactId: 'c2',
        eta: '10:45',
      },
    },
    res
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'ETA_SEND_FAILED');
});
