import {
  ensureRouteLiveState,
  setRouteLiveState,
} from './route-live-store.js';
import ghlHandler from '../api/ghl.js';
import {
  loadAndEnsureRouteState as loadAndEnsureRouteStateCore,
  mergeRoutePayload,
  routeStateConflictResponse,
  validateBaseBody,
} from './route-live-api.js';
import { buildNextEtaPreview, resolveSendNextEta } from './route-next-eta-core.js';
import { sendGeplandeAankomstEtaToContact } from './ghl-eta-send.js';

function json(res, status, body) {
  res.status(status).json(body);
}

function cleanString(value) {
  return String(value || '').trim();
}

async function defaultLoadAppointments({ req, dateStr }) {
  const sourceReq = req && typeof req === 'object' ? req : {};
  const sourceHeaders = sourceReq.headers && typeof sourceReq.headers === 'object' ? sourceReq.headers : {};
  const mockReq = {
    ...sourceReq,
    method: 'GET',
    headers: { host: 'localhost', ...sourceHeaders },
    query: { ...(sourceReq.query || {}), action: 'getAppointments', date: dateStr },
    body: {},
  };
  const mockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader() {},
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
  await ghlHandler(mockReq, mockRes);
  if (mockRes.statusCode >= 400) {
    throw new Error(mockRes.body?.error || `getAppointments failed (${mockRes.statusCode})`);
  }
  return Array.isArray(mockRes.body?.appointments) ? mockRes.body.appointments : [];
}

async function loadAndEnsureRouteState({ req, locationId, dateStr }) {
  return loadAndEnsureRouteStateCore({
    deps: {
      loadAppointments: defaultLoadAppointments,
      ensureRouteLiveState,
    },
    req,
    locationId,
    dateStr,
  });
}

function defaultDeps() {
  return {
    loadAndEnsureRouteState,
    setRouteLiveState,
    buildNextEtaPreview,
    resolveSendNextEta,
    sendGeplandeAankomstEtaToContact,
    ghlApiKey: () => cleanString(process.env.GHL_API_KEY),
    geplandeAankomstFieldId: () =>
      cleanString(process.env.GHL_GEPLANDE_AANKOMST_FIELD_ID) || 'XELcOSdWq3tqRtpLE5x8',
    mapsKey: () => cleanString(process.env.GOOGLE_MAPS_API_KEY),
  };
}

export function createNextEtaPreviewHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  return async function nextEtaPreviewHandler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

    const locationId = cleanString(req.query?.locationId);
    const dateStr = cleanString(req.query?.dateStr || req.query?.date);
    const currentContactId = cleanString(req.query?.currentContactId);
    if (!locationId) return json(res, 400, { ok: false, code: 'LOCATION_ID_REQUIRED' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return json(res, 400, { ok: false, code: 'BAD_DATE' });
    if (!currentContactId) return json(res, 400, { ok: false, code: 'CURRENT_CONTACT_ID_REQUIRED' });

    const loaded = await deps.loadAndEnsureRouteState({
      req,
      locationId,
      dateStr,
    });
    if (!loaded.ok) return json(res, 500, { ok: false, code: loaded.code });

    const preview = await deps.buildNextEtaPreview({
      routeState: loaded.routeState,
      appointments: loaded.appointments,
      currentContactId,
      mapsKey: deps.mapsKey(),
    });

    if (!preview.ok && preview.code === 'ETA_CALC_FAILED') {
      return json(res, 200, {
        ok: false,
        code: 'ETA_CALC_FAILED',
        nextContact: preview.nextContact || null,
      });
    }

    if (!preview.nextContact) {
      return json(res, 200, { ok: true, nextContact: null });
    }

    return json(res, 200, {
      ok: true,
      nextContact: preview.nextContact,
      etaTime: preview.etaTime || null,
    });
  };
}

export function createSendNextEtaHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  return async function sendNextEtaHandler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

    const base = validateBaseBody(req.body || {});
    if (!base.ok) return json(res, base.status, { ok: false, code: base.code });

    const currentContactId = cleanString(req.body?.currentContactId);
    const nextContactId = cleanString(req.body?.nextContactId);
    const clientEta = cleanString(req.body?.eta);
    if (!nextContactId) return json(res, 400, { ok: false, code: 'NEXT_CONTACT_ID_REQUIRED' });

    const loaded = await deps.loadAndEnsureRouteState({
      req,
      locationId: base.locationId,
      dateStr: base.dateStr,
    });
    if (!loaded.ok) return json(res, 500, { ok: false, code: loaded.code });

    const resolved = await deps.resolveSendNextEta({
      routeState: loaded.routeState,
      appointments: loaded.appointments,
      currentContactId,
      nextContactId,
      clientEta,
      mapsKey: deps.mapsKey(),
    });

    if (!resolved.ok) {
      const status = resolved.code === 'STALE_CONTACT_ID' ? 400 : 500;
      return json(res, status, { ok: false, code: resolved.code || 'ETA_SEND_FAILED' });
    }

    const apiKey = deps.ghlApiKey();
    if (!apiKey) {
      return json(res, 503, { ok: false, code: 'ETA_SEND_FAILED', error: 'GHL_API_KEY missing' });
    }

    const ghlOut = await deps.sendGeplandeAankomstEtaToContact({
      apiKey,
      contactId: nextContactId,
      etaStr: resolved.sentEta,
      geplandeAankomstFieldId: deps.geplandeAankomstFieldId(),
      logPrefix: '[route/send-next-eta]',
    });

    if (!ghlOut.ok) {
      return json(res, 500, { ok: false, code: 'ETA_SEND_FAILED', detail: ghlOut.code });
    }

    const now = Date.now();
    const etaSentByContactId = {
      ...(loaded.routeState.etaSentByContactId || {}),
      [nextContactId]: { eta: resolved.sentEta, sentAt: now },
    };
    const etasByContactId = {
      ...(loaded.routeState.etasByContactId || {}),
      [nextContactId]: resolved.sentEta,
    };

    const out = await deps.setRouteLiveState(
      base.locationId,
      base.dateStr,
      mergeRoutePayload({
        routeState: loaded.routeState,
        patch: {
          etaSentByContactId,
          etasByContactId,
        },
        expectedRevision: base.expectedRevision,
        updatedBy: base.updatedBy,
        source: 'send_next_eta',
      })
    );

    if (!out.ok && (out.code === 'REVISION_CONFLICT' || out.code === 'EXPECTED_REVISION_REQUIRED')) {
      return json(res, 409, routeStateConflictResponse(out));
    }
    if (!out.ok) {
      return json(res, 500, { ok: false, code: 'ETA_SEND_FAILED', detail: out.code });
    }

    return json(res, 200, {
      ok: true,
      sentEta: resolved.sentEta,
      nextContact: resolved.nextContact,
      routeState: out.routeState,
    });
  };
}
