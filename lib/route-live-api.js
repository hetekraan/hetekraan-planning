import ghlHandler from '../api/ghl.js';
import {
  ensureRouteLiveState,
  routeInputFingerprintFromAppointments,
  setRouteLiveState,
} from './route-live-store.js';
import {
  activeRouteAppointments,
  defaultOptimizeRoute,
  optimizeForRouteState,
} from './route-live-optimizer.js';

function json(res, status, body) {
  res.status(status).json(body);
}

function cleanString(value) {
  return String(value || '').trim();
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '').trim());
}

function expectedRevisionFromBody(body) {
  if (body?.expectedRevision === undefined || body?.expectedRevision === null) return undefined;
  const n = Number(body.expectedRevision);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
}

function routeStateConflictResponse(out) {
  return {
    ok: false,
    code: out.code,
    currentRouteState: out.currentRoute || out.currentRouteState || null,
  };
}

function validateBaseBody(body) {
  const locationId = cleanString(body?.locationId);
  const dateStr = cleanString(body?.dateStr || body?.date);
  if (!locationId) return { ok: false, status: 400, code: 'LOCATION_ID_REQUIRED' };
  if (!dateStr) return { ok: false, status: 400, code: 'DATE_REQUIRED' };
  if (!isValidDateStr(dateStr)) return { ok: false, status: 400, code: 'BAD_DATE' };
  const expectedRevision = expectedRevisionFromBody(body);
  if (Number.isNaN(expectedRevision)) return { ok: false, status: 400, code: 'BAD_EXPECTED_REVISION' };
  return {
    ok: true,
    locationId,
    dateStr,
    expectedRevision,
    updatedBy: cleanString(body?.updatedBy) || null,
  };
}

function createMockJsonRes() {
  const out = {
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
    end() {
      return this;
    },
  };
  return out;
}

async function defaultLoadAppointments({ req, dateStr }) {
  const mockReq = {
    ...req,
    method: 'GET',
    query: { ...(req.query || {}), action: 'getAppointments', date: dateStr },
    body: {},
  };
  const mockRes = createMockJsonRes();
  await ghlHandler(mockReq, mockRes);
  if (mockRes.statusCode >= 400) {
    const err = new Error(mockRes.body?.error || `getAppointments failed (${mockRes.statusCode})`);
    err.statusCode = mockRes.statusCode;
    err.code = mockRes.body?.code || 'APPOINTMENTS_LOAD_FAILED';
    throw err;
  }
  return Array.isArray(mockRes.body?.appointments) ? mockRes.body.appointments : [];
}

async function loadAndEnsureRouteState({ deps, req, locationId, dateStr }) {
  try {
    const appointments = await deps.loadAppointments({ req, locationId, dateStr });
    const ensured = await deps.ensureRouteLiveState(locationId, dateStr, appointments);
    if (!ensured?.ok) return { ok: false, code: 'ROUTE_LIVE_INIT_FAILED' };
    return { ok: true, appointments, routeState: ensured.routeState };
  } catch (err) {
    console.error('[route/live] init failed', err?.message || err);
    return { ok: false, code: 'ROUTE_LIVE_INIT_FAILED' };
  }
}

function mergeRoutePayload({ routeState, patch, expectedRevision, updatedBy, source }) {
  const now = Date.now();
  return {
    ...routeState,
    ...patch,
    expectedRevision,
    updatedBy: updatedBy || null,
    updatedAt: now,
    source,
  };
}

function defaultDeps() {
  return {
    ensureRouteLiveState,
    setRouteLiveState,
    loadAppointments: defaultLoadAppointments,
    optimizeRoute: defaultOptimizeRoute,
  };
}

export function createReorderHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  return async function reorderHandler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    const base = validateBaseBody(req.body || {});
    if (!base.ok) return json(res, base.status, { ok: false, code: base.code });

    const orderedContactIds = Array.isArray(req.body?.orderedContactIds)
      ? req.body.orderedContactIds.map(cleanString).filter(Boolean)
      : [];
    const movedContactId = cleanString(req.body?.movedContactId);
    if (!orderedContactIds.length) return json(res, 400, { ok: false, code: 'ORDER_REQUIRED' });
    if (!movedContactId) return json(res, 400, { ok: false, code: 'MOVED_CONTACT_ID_REQUIRED' });
    if (!orderedContactIds.includes(movedContactId)) {
      return json(res, 400, { ok: false, code: 'MOVED_CONTACT_NOT_IN_ORDER' });
    }

    const loaded = await loadAndEnsureRouteState({
      deps,
      req,
      locationId: base.locationId,
      dateStr: base.dateStr,
    });
    if (!loaded.ok) return json(res, 500, { ok: false, code: loaded.code });
    const appointments = loaded.appointments;
    const active = activeRouteAppointments(appointments);
    const activeIds = new Set(active.map((a) => cleanString(a.contactId)));
    const staleIds = orderedContactIds.filter((id) => !activeIds.has(id));
    if (staleIds.length) {
      return json(res, 400, { ok: false, code: 'STALE_OR_KLAAR_CONTACT', staleContactIds: staleIds });
    }

    let plan;
    try {
      plan = await optimizeForRouteState({
        activeAppointments: active,
        routeState: loaded.routeState,
        optimizeRoute: deps.optimizeRoute,
        preserveOrderIds: orderedContactIds,
      });
    } catch (err) {
      console.error('[route/reorder] optimize failed', err?.message || err);
      return json(res, 500, { ok: false, code: 'OPTIMIZE_FAILED' });
    }

    const movedIdx = orderedContactIds.indexOf(movedContactId);
    const prev = movedIdx > 0 ? orderedContactIds[movedIdx - 1] : '';
    const pinsByContactId = { ...(loaded.routeState.pinsByContactId || {}) };
    if (req.body?.pin !== false) {
      pinsByContactId[movedContactId] = {
        type: 'manual_order',
        anchor: prev ? `after:${prev}` : 'start',
        createdAt: Date.now(),
        createdBy: base.updatedBy,
      };
    }

    const out = await deps.setRouteLiveState(
      base.locationId,
      base.dateStr,
      mergeRoutePayload({
        routeState: loaded.routeState,
        patch: {
          orderContactIds: plan.orderContactIds,
          etasByContactId: plan.etasByContactId,
          pinsByContactId,
          lastOptimizedAt: Date.now(),
          lastRouteInputChangedAt: Date.now(),
          routeInputFingerprint: routeInputFingerprintFromAppointments(appointments),
        },
        expectedRevision: base.expectedRevision,
        updatedBy: base.updatedBy,
        source: 'manual_reorder',
      })
    );
    if (!out.ok && (out.code === 'REVISION_CONFLICT' || out.code === 'EXPECTED_REVISION_REQUIRED')) {
      return json(res, 409, routeStateConflictResponse(out));
    }
    if (!out.ok) return json(res, 400, { ok: false, code: out.code || 'ROUTE_WRITE_FAILED' });
    return json(res, 200, { ok: true, routeState: out.routeState });
  };
}

export function createUnpinHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  return async function unpinHandler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    const base = validateBaseBody(req.body || {});
    if (!base.ok) return json(res, base.status, { ok: false, code: base.code });
    const contactId = cleanString(req.body?.contactId);
    if (!contactId) return json(res, 400, { ok: false, code: 'CONTACT_ID_REQUIRED' });

    const loaded = await loadAndEnsureRouteState({
      deps,
      req,
      locationId: base.locationId,
      dateStr: base.dateStr,
    });
    if (!loaded.ok) return json(res, 500, { ok: false, code: loaded.code });
    const appointments = loaded.appointments;
    const pinsByContactId = { ...(loaded.routeState.pinsByContactId || {}) };
    if (!pinsByContactId[contactId]) return json(res, 200, { ok: true, routeState: loaded.routeState, noop: true });
    delete pinsByContactId[contactId];

    let plan;
    try {
      plan = await optimizeForRouteState({
        activeAppointments: activeRouteAppointments(appointments),
        routeState: { ...loaded.routeState, pinsByContactId },
        optimizeRoute: deps.optimizeRoute,
      });
    } catch (err) {
      console.error('[route/unpin] optimize failed', err?.message || err);
      return json(res, 500, { ok: false, code: 'OPTIMIZE_FAILED' });
    }

    const out = await deps.setRouteLiveState(
      base.locationId,
      base.dateStr,
      mergeRoutePayload({
        routeState: loaded.routeState,
        patch: {
          orderContactIds: plan.orderContactIds,
          etasByContactId: plan.etasByContactId,
          pinsByContactId,
          lastOptimizedAt: Date.now(),
          routeInputFingerprint: routeInputFingerprintFromAppointments(appointments),
        },
        expectedRevision: base.expectedRevision,
        updatedBy: base.updatedBy,
        source: 'manual_unpin',
      })
    );
    if (!out.ok && (out.code === 'REVISION_CONFLICT' || out.code === 'EXPECTED_REVISION_REQUIRED')) {
      return json(res, 409, routeStateConflictResponse(out));
    }
    if (!out.ok) return json(res, 400, { ok: false, code: out.code || 'ROUTE_WRITE_FAILED' });
    return json(res, 200, { ok: true, routeState: out.routeState });
  };
}

export function createOptimizeHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  return async function optimizeHandler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    const base = validateBaseBody(req.body || {});
    if (!base.ok) return json(res, base.status, { ok: false, code: base.code });
    const reason = cleanString(req.body?.reason) || 'manual_button';

    const loaded = await loadAndEnsureRouteState({
      deps,
      req,
      locationId: base.locationId,
      dateStr: base.dateStr,
    });
    if (!loaded.ok) return json(res, 500, { ok: false, code: loaded.code });
    const appointments = loaded.appointments;

    let plan;
    try {
      plan = await optimizeForRouteState({
        activeAppointments: activeRouteAppointments(appointments),
        routeState: loaded.routeState,
        optimizeRoute: deps.optimizeRoute,
      });
    } catch (err) {
      console.error('[route/optimize] optimize failed', err?.message || err);
      return json(res, 500, { ok: false, code: 'OPTIMIZE_FAILED' });
    }

    const source = reason === 'manual_button' ? 'manual_optimize' : 'auto_optimize';
    const now = Date.now();
    const out = await deps.setRouteLiveState(
      base.locationId,
      base.dateStr,
      mergeRoutePayload({
        routeState: loaded.routeState,
        patch: {
          orderContactIds: plan.orderContactIds,
          etasByContactId: plan.etasByContactId,
          pinsByContactId: loaded.routeState.pinsByContactId || {},
          internalFixedStartByContactId: loaded.routeState.internalFixedStartByContactId || {},
          lastOptimizedAt: now,
          routeInputFingerprint: routeInputFingerprintFromAppointments(appointments),
        },
        expectedRevision: base.expectedRevision,
        updatedBy: base.updatedBy,
        source,
      })
    );
    if (!out.ok && (out.code === 'REVISION_CONFLICT' || out.code === 'EXPECTED_REVISION_REQUIRED')) {
      return json(res, 409, routeStateConflictResponse(out));
    }
    if (!out.ok) return json(res, 400, { ok: false, code: out.code || 'ROUTE_WRITE_FAILED' });
    return json(res, 200, { ok: true, routeState: out.routeState });
  };
}
