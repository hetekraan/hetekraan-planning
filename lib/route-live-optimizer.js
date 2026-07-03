import { optimizeRoutePayload } from '../api/optimize-route.js';
import {
  applyOptimizedOrderToRoute,
  enforceMorningBeforeAfternoonOrder,
  resolveAppointmentDayPart,
  routeOrderViolatesMorningBeforeAfternoon,
} from './route-day-part-order.js';
import { plannedMinutesForType } from './booking-blocks.js';
import {
  ensureRouteLiveState,
  routeInputFingerprintFromAppointments,
  setRouteLiveState,
} from './route-live-store.js';

function cleanString(value) {
  return String(value || '').trim();
}

/** Parse een interne-vaste-tijd waarde naar { type, time } of null. */
function internalFixedEntryFromValue(value) {
  if (value && typeof value === 'object') {
    const type = cleanString(value.type).toLowerCase();
    const time = cleanString(value.time);
    if ((type === 'exact' || type === 'after' || type === 'before') && /^\d{1,2}:\d{2}$/.test(time)) {
      return { type, time };
    }
    return null;
  }
  const s = cleanString(value);
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      return internalFixedEntryFromValue(JSON.parse(s));
    } catch {
      /* val terug op plain-tijd hieronder */
    }
  }
  const m = /^~?(\d{1,2}:\d{2})$/.exec(s);
  return m ? { type: 'exact', time: m[1] } : null;
}

/**
 * Houd de autoritatieve interne-vaste-tijd map (routeState.internalFixedStartByContactId)
 * in sync met de constraints op de appointments. Voor elk meegegeven appointment:
 * - met geldige interne tijd → zet/overschrijf entry
 * - zonder (verwijderd) → verwijder entry
 * Contacten die niet in `appointments` zitten blijven ongewijzigd.
 *
 * @param {object} routeState
 * @param {object[]} appointments
 * @returns {Record<string, { type: string, time: string }>}
 */
export function mergeInternalFixedFromAppointments(routeState, appointments) {
  const base = routeState?.internalFixedStartByContactId;
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  const rows = Array.isArray(appointments) ? appointments : [];
  for (const a of rows) {
    const cid = cleanString(a?.contactId);
    if (!cid) continue;
    const pin = internalFixedEntryFromValue(
      a?.internalFixedPin ?? a?.internalFixedStart ?? a?.internalFixedStartTime
    );
    if (pin) out[cid] = pin;
    else delete out[cid];
  }
  return out;
}

export function activeRouteAppointments(appointments) {
  return (Array.isArray(appointments) ? appointments : []).filter(
    (a) => a?.contactId && !a?.isCalBlock && cleanString(a?.status).toLowerCase() !== 'klaar'
  );
}

export function appointmentToOptimizePayload(a) {
  const dayPart = resolveAppointmentDayPart(a);
  return {
    contactId: cleanString(a.contactId),
    address: a.fullAddressLine || a.address,
    timeWindow: a.timeWindow || null,
    jobDuration: plannedMinutesForType(a.jobType),
    dayPart,
    internalFixedStart: a.internalFixedPin || a.internalFixedStart || a.internalFixedStartTime || undefined,
  };
}

export async function defaultOptimizeRoute({ appointments, preserveOrder }) {
  const result = await optimizeRoutePayload({
    appointments: appointments.map(appointmentToOptimizePayload),
    // preserveOrder mag boolean of { morning, afternoon } zijn (per-dagdeel).
    preserveOrder: preserveOrder && typeof preserveOrder === 'object' ? preserveOrder : preserveOrder === true,
    mode: 'partitionedDay',
    returnToDepot: true,
  });
  const order = Array.isArray(result?.order) ? result.order : appointments.map((_, i) => i);
  const etas = Array.isArray(result?.etas) ? result.etas : [];
  let orderContactIds = order
    .map((idx) => appointments[idx]?.contactId)
    .map(cleanString)
    .filter(Boolean);
  orderContactIds = enforceMorningBeforeAfternoonOrder(orderContactIds, appointments);
  const violations = Array.isArray(result?.violations) ? result.violations : [];
  const violationsByContactId = {};
  for (const v of violations) {
    const cid = cleanString(appointments[v?.apptIdx]?.contactId);
    if (!cid) continue;
    const { apptIdx, ...rest } = v;
    violationsByContactId[cid] = rest;
  }
  return {
    orderContactIds,
    etasByContactId: Object.fromEntries(
      order
        .map((idx, step) => [cleanString(appointments[idx]?.contactId), cleanString(etas[step])])
        .filter(([contactId, eta]) => contactId && eta)
    ),
    violations,
    violationsByContactId,
  };
}

function orderedAppointmentsByContactIds(active, orderedContactIds) {
  const byContactId = new Map(active.map((a) => [cleanString(a.contactId), a]));
  return orderedContactIds.map((id) => byContactId.get(cleanString(id))).filter(Boolean);
}

/** Behoud volledige route-volgorde; filter alleen welke ids nog actief zijn voor ETA-berekening. */
export function preservedActiveOrderFromRouteState(routeState, activeAppointments) {
  const existing = Array.isArray(routeState?.orderContactIds)
    ? routeState.orderContactIds.map(cleanString).filter(Boolean)
    : [];
  const activeIds = new Set(
    (Array.isArray(activeAppointments) ? activeAppointments : [])
      .map((a) => cleanString(a?.contactId))
      .filter(Boolean)
  );
  const preserved = existing.filter((id) => activeIds.has(id));
  for (const a of activeAppointments) {
    const cid = cleanString(a?.contactId);
    if (cid && !preserved.includes(cid)) preserved.push(cid);
  }
  return preserved;
}

/** Volledige orderContactIds: bestaande volgorde + nieuwe actieve stops achteraan. */
export function mergeRouteOrderPreservingStatus(routeState, activeAppointments) {
  const existing = Array.isArray(routeState?.orderContactIds)
    ? routeState.orderContactIds.map(cleanString).filter(Boolean)
    : [];
  const activeIds = new Set(
    (Array.isArray(activeAppointments) ? activeAppointments : [])
      .map((a) => cleanString(a?.contactId))
      .filter(Boolean)
  );
  const out = existing.slice();
  const seen = new Set(out);
  for (const cid of activeIds) {
    if (!seen.has(cid)) {
      out.push(cid);
      seen.add(cid);
    }
  }
  return out.length ? out : preservedActiveOrderFromRouteState(routeState, activeAppointments);
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
  preserveDayParts = null,
}) {
  if (!activeAppointments.length) {
    return { orderContactIds: [], etasByContactId: {}, violations: [], violationsByContactId: {} };
  }

  // Per-dagdeel: behoud het ene dagdeel in bestaande volgorde, heroptimaliseer het
  // andere (bv. na een constraint-save). De preserved-dagdelen houden hun volgorde
  // doordat we de bestaande order als input meegeven; het geoptimaliseerde dagdeel
  // negeert die input (greedy/pin-aware in handlePartitionedDay).
  if (preserveDayParts && typeof preserveDayParts === 'object') {
    const baseOrder = enforceMorningBeforeAfternoonOrder(
      Array.isArray(preserveOrderIds) && preserveOrderIds.length
        ? preserveOrderIds
        : preservedActiveOrderFromRouteState(routeState, activeAppointments),
      activeAppointments
    );
    const ordered = orderedAppointmentsByContactIds(activeAppointments, baseOrder);
    const plan = await optimizeRoute({ appointments: ordered, preserveOrder: preserveDayParts });
    plan.orderContactIds = enforceMorningBeforeAfternoonOrder(plan.orderContactIds, activeAppointments);
    return plan;
  }

  if (Array.isArray(preserveOrderIds)) {
    const enforcedIds = enforceMorningBeforeAfternoonOrder(preserveOrderIds, activeAppointments);
    const ordered = orderedAppointmentsByContactIds(activeAppointments, enforcedIds);
    const plan = await optimizeRoute({ appointments: ordered, preserveOrder: true });
    plan.orderContactIds = enforceMorningBeforeAfternoonOrder(plan.orderContactIds, activeAppointments);
    return plan;
  }

  const optimized = await optimizeRoute({ appointments: activeAppointments, preserveOrder: false });
  let finalOrderIds = applyPinnedPositions(
    optimized.orderContactIds,
    Array.isArray(routeState?.orderContactIds) ? routeState.orderContactIds : [],
    routeState?.pinsByContactId
  );
  finalOrderIds = enforceMorningBeforeAfternoonOrder(finalOrderIds, activeAppointments);
  if (finalOrderIds.join('|') === optimized.orderContactIds.join('|')) {
    optimized.orderContactIds = finalOrderIds;
    return optimized;
  }
  const ordered = orderedAppointmentsByContactIds(activeAppointments, finalOrderIds);
  const plan = await optimizeRoute({ appointments: ordered, preserveOrder: true });
  plan.orderContactIds = enforceMorningBeforeAfternoonOrder(plan.orderContactIds, activeAppointments);
  return plan;
}

/**
 * Verwijder manual_order pins van contacten in één dagdeel; pins van het andere
 * dagdeel (en van contacten die niet meer actief zijn) blijven ongemoeid.
 * @param {Record<string, object>} pins
 * @param {object[]} activeAppointments
 * @param {0|1} dayPart
 */
export function pinsWithoutDayPart(pins, activeAppointments, dayPart) {
  const src = pins && typeof pins === 'object' ? pins : {};
  const dpById = new Map(
    (Array.isArray(activeAppointments) ? activeAppointments : [])
      .map((a) => [cleanString(a?.contactId), resolveAppointmentDayPart(a)])
      .filter(([id]) => id)
  );
  const out = {};
  for (const [cid, pin] of Object.entries(src)) {
    if (dpById.get(cleanString(cid)) === dayPart) continue;
    out[cid] = pin;
  }
  return out;
}

export async function triggerLiveRouteRecalculation({
  locationId,
  dateStr,
  appointments,
  reason,
  updatedBy = null,
  changedContactId = null,
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
    const active = activeRouteAppointments(rows);
    const dayPartViolation = routeOrderViolatesMorningBeforeAfternoon(
      ensured.routeState.orderContactIds,
      rows
    );
    const repairDayPart = why === 'day_part_order_repair' || dayPartViolation;

    // Constraint-save: heroptimaliseer alleen het dagdeel van de gewijzigde stop,
    // behoud het andere dagdeel, en wis de manual_order pins van dát dagdeel zodat
    // de optimize effect heeft. Bij verwijderde constraint (geen pin meer) → geen
    // reorder (decision a): val terug op het normale preserve-pad.
    let preserveDayParts = null;
    let pinsByContactId = ensured.routeState.pinsByContactId || {};
    const changedCid = cleanString(changedContactId);
    if (why === 'setInternalFixedStart' && changedCid && !repairDayPart) {
      const changed = active.find((a) => cleanString(a?.contactId) === changedCid);
      const stillHasConstraint = changed
        ? internalFixedEntryFromValue(
            changed.internalFixedPin ?? changed.internalFixedStart ?? changed.internalFixedStartTime
          )
        : null;
      if (changed && stillHasConstraint) {
        const dp = resolveAppointmentDayPart(changed);
        preserveDayParts = { morning: dp !== 0, afternoon: dp !== 1 };
        pinsByContactId = pinsWithoutDayPart(pinsByContactId, active, dp);
      }
    }

    const preservedOrder = repairDayPart
      ? null
      : preservedActiveOrderFromRouteState(ensured.routeState, active);
    const plan = await optimizeForRouteState({
      activeAppointments: active,
      routeState: { ...ensured.routeState, pinsByContactId },
      optimizeRoute,
      preserveOrderIds: preserveDayParts ? null : preservedOrder?.length ? preservedOrder : null,
      preserveDayParts,
    });
    const nextOrder = applyOptimizedOrderToRoute(
      ensured.routeState.orderContactIds,
      active,
      plan.orderContactIds
    );
    const out = await write(loc, date, {
      ...ensured.routeState,
      orderContactIds: nextOrder,
      etasByContactId: {
        ...(ensured.routeState.etasByContactId || {}),
        ...plan.etasByContactId,
      },
      violationsByContactId: plan.violationsByContactId || {},
      pinsByContactId,
      internalFixedStartByContactId: mergeInternalFixedFromAppointments(ensured.routeState, active),
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
