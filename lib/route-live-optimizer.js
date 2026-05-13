import optimizeRouteHandler from '../api/optimize-route.js';
import {
  ensureRouteLiveState,
  routeInputFingerprintFromAppointments,
  setRouteLiveState,
} from './route-live-store.js';

const JOB_DURATION = { onderhoud: 45, reparatie: 60, installatie: 90 };

function cleanString(value) {
  return String(value || '').trim();
}

function createMockJsonRes() {
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
    end() {
      return this;
    },
  };
}

export function activeRouteAppointments(appointments) {
  return (Array.isArray(appointments) ? appointments : []).filter(
    (a) => a?.contactId && !a?.isCalBlock && cleanString(a?.status).toLowerCase() !== 'klaar'
  );
}

export function appointmentToOptimizePayload(a) {
  return {
    address: a.fullAddressLine || a.address,
    timeWindow: a.timeWindow || null,
    jobDuration: JOB_DURATION[a.jobType] || 30,
    dayPart: a.dayPart,
    internalFixedStart: a.internalFixedPin || a.internalFixedStart || a.internalFixedStartTime || undefined,
  };
}

export async function defaultOptimizeRoute({ appointments, preserveOrder }) {
  const mockReq = {
    method: 'POST',
    body: {
      appointments: appointments.map(appointmentToOptimizePayload),
      preserveOrder: preserveOrder === true,
    },
  };
  const mockRes = createMockJsonRes();
  await optimizeRouteHandler(mockReq, mockRes);
  if (mockRes.statusCode >= 400) {
    const err = new Error(mockRes.body?.message || mockRes.body?.error || 'optimize failed');
    err.statusCode = mockRes.statusCode;
    err.code = 'OPTIMIZE_FAILED';
    throw err;
  }
  const order = Array.isArray(mockRes.body?.order) ? mockRes.body.order : appointments.map((_, i) => i);
  const etas = Array.isArray(mockRes.body?.etas) ? mockRes.body.etas : [];
  return {
    orderContactIds: order
      .map((idx) => appointments[idx]?.contactId)
      .map(cleanString)
      .filter(Boolean),
    etasByContactId: Object.fromEntries(
      order
        .map((idx, step) => [cleanString(appointments[idx]?.contactId), cleanString(etas[step])])
        .filter(([contactId, eta]) => contactId && eta)
    ),
    violations: Array.isArray(mockRes.body?.violations) ? mockRes.body.violations : [],
  };
}

function orderedAppointmentsByContactIds(active, orderedContactIds) {
  const byContactId = new Map(active.map((a) => [cleanString(a.contactId), a]));
  return orderedContactIds.map((id) => byContactId.get(cleanString(id))).filter(Boolean);
}

function applyPinnedPositions(optimizedIds, currentOrderIds, pinsByContactId) {
  const pins = pinsByContactId && typeof pinsByContactId === 'object' ? pinsByContactId : {};
  const pinnedIds = Object.keys(pins).filter(Boolean);
  if (!pinnedIds.length) return optimizedIds;
  const remaining = optimizedIds.filter((id) => !pinnedIds.includes(id));
  const out = remaining.slice();
  for (const pinnedId of currentOrderIds.filter((id) => pinnedIds.includes(id))) {
    const oldIdx = currentOrderIds.indexOf(pinnedId);
    const idx = Math.max(0, Math.min(oldIdx, out.length));
    out.splice(idx, 0, pinnedId);
  }
  return out;
}

export async function optimizeForRouteState({
  activeAppointments,
  routeState,
  optimizeRoute = defaultOptimizeRoute,
  preserveOrderIds = null,
}) {
  if (!activeAppointments.length) {
    return { orderContactIds: [], etasByContactId: {}, violations: [] };
  }

  if (Array.isArray(preserveOrderIds)) {
    const ordered = orderedAppointmentsByContactIds(activeAppointments, preserveOrderIds);
    return optimizeRoute({ appointments: ordered, preserveOrder: true });
  }

  const optimized = await optimizeRoute({ appointments: activeAppointments, preserveOrder: false });
  const finalOrderIds = applyPinnedPositions(
    optimized.orderContactIds,
    Array.isArray(routeState?.orderContactIds) ? routeState.orderContactIds : [],
    routeState?.pinsByContactId
  );
  if (finalOrderIds.join('|') === optimized.orderContactIds.join('|')) return optimized;
  const ordered = orderedAppointmentsByContactIds(activeAppointments, finalOrderIds);
  return optimizeRoute({ appointments: ordered, preserveOrder: true });
}

export async function triggerLiveRouteRecalculation({
  locationId,
  dateStr,
  appointments,
  reason,
  updatedBy = null,
  deps = {},
}) {
  const loc = cleanString(locationId);
  const date = cleanString(dateStr);
  const why = cleanString(reason) || 'auto_appointment_mutation';
  if (!loc || !date) return { ok: false, skipped: true, code: 'MISSING_ROUTE_RECALC_INPUT' };
  try {
    console.info(
      'route_live_auto_recalc_triggered',
      JSON.stringify({ reason: why, date, locationId: loc })
    );
    const ensure = deps.ensureRouteLiveState || ensureRouteLiveState;
    const write = deps.setRouteLiveState || setRouteLiveState;
    const optimizeRoute = deps.optimizeRoute || defaultOptimizeRoute;
    const rows = Array.isArray(appointments) ? appointments : [];
    const ensured = await ensure(loc, date, rows);
    if (!ensured?.ok || !ensured.routeState) {
      return { ok: false, code: ensured?.code || 'ROUTE_LIVE_INIT_FAILED' };
    }
    const now = Date.now();
    const plan = await optimizeForRouteState({
      activeAppointments: activeRouteAppointments(rows),
      routeState: ensured.routeState,
      optimizeRoute,
    });
    const out = await write(loc, date, {
      ...ensured.routeState,
      orderContactIds: plan.orderContactIds,
      etasByContactId: plan.etasByContactId,
      pinsByContactId: ensured.routeState.pinsByContactId || {},
      internalFixedStartByContactId: ensured.routeState.internalFixedStartByContactId || {},
      routeInputFingerprint: routeInputFingerprintFromAppointments(rows),
      lastOptimizedAt: now,
      updatedAt: now,
      updatedBy: cleanString(updatedBy) || null,
      source: 'auto_optimize',
      expectedRevision: ensured.routeState.revision,
    });
    if (!out.ok) {
      console.warn(
        'route_live_auto_recalc_failed',
        JSON.stringify({ reason: why, date, locationId: loc, code: out.code || 'ROUTE_WRITE_FAILED' })
      );
      return { ok: false, code: out.code || 'ROUTE_WRITE_FAILED', currentRouteState: out.currentRoute || null };
    }
    return { ok: true, routeState: out.routeState };
  } catch (err) {
    console.warn(
      'route_live_auto_recalc_failed',
      JSON.stringify({ reason: why, date, locationId: loc, error: err?.message || String(err) })
    );
    return { ok: false, code: err?.code || 'ROUTE_RECALC_FAILED' };
  }
}
