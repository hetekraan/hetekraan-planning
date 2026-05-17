/**
 * Ochtend (dayPart 0) vóór middag (dayPart 1) in route-volgorde.
 */

function cleanString(value) {
  return String(value || '').trim();
}

/** @returns {0|1} */
export function resolveAppointmentDayPart(appt) {
  if (!appt || typeof appt !== 'object') return 1;
  const raw = appt.dayPart;
  if (raw === 0 || raw === '0') return 0;
  if (raw === 1 || raw === '1') return 1;
  const tw = String(appt.timeWindow || '').toLowerCase();
  if (tw.includes('middag') || tw.includes('13:00–17:00') || tw.includes('13:00-17:00')) return 1;
  if (tw.includes('ochtend') || tw.includes('09:00–13:00') || tw.includes('09:00-13:00')) return 0;
  return 1;
}

/**
 * Houd relatieve volgorde binnen ochtend/middag, maar alle ochtend vóór alle middag.
 * @param {string[]} orderContactIds
 * @param {Array<{ contactId?: string, dayPart?: number, timeWindow?: string }>} appointments
 */
export function enforceMorningBeforeAfternoonOrder(orderContactIds, appointments) {
  const byId = new Map();
  for (const a of Array.isArray(appointments) ? appointments : []) {
    const cid = cleanString(a?.contactId);
    if (cid) byId.set(cid, a);
  }
  const morning = [];
  const afternoon = [];
  for (const id of Array.isArray(orderContactIds) ? orderContactIds : []) {
    const cid = cleanString(id);
    if (!cid) continue;
    const appt = byId.get(cid);
    if (!appt) {
      afternoon.push(cid);
      continue;
    }
    if (resolveAppointmentDayPart(appt) === 0) morning.push(cid);
    else afternoon.push(cid);
  }
  return [...morning, ...afternoon];
}

/**
 * Vervang actieve ids door geoptimaliseerde volgorde; klaar/inactieve ids blijven op plek.
 */
export function applyOptimizedOrderToRoute(existingOrder, activeAppointments, optimizedActiveOrder) {
  const activeById = new Map(
    (Array.isArray(activeAppointments) ? activeAppointments : [])
      .map((a) => [cleanString(a.contactId), a])
      .filter(([id]) => id)
  );
  const enforced = enforceMorningBeforeAfternoonOrder(
    Array.isArray(optimizedActiveOrder) ? optimizedActiveOrder : [],
    activeAppointments
  );
  const queue = [...enforced];
  const out = [];
  for (const id of Array.isArray(existingOrder) ? existingOrder : []) {
    const cid = cleanString(id);
    if (activeById.has(cid)) {
      if (queue.length) out.push(queue.shift());
    } else {
      out.push(cid);
    }
  }
  while (queue.length) out.push(queue.shift());
  for (const cid of activeById.keys()) {
    if (!out.includes(cid)) out.push(cid);
  }
  return out;
}

export function logRouteOptimizeInput(appointments, tag = 'route_optimize_input') {
  const rows = (Array.isArray(appointments) ? appointments : []).map((a) => ({
    contactId: cleanString(a?.contactId),
    timeSlot: cleanString(a?.timeSlot),
    timeWindow: a?.timeWindow != null ? String(a.timeWindow) : null,
    dayPart: a?.dayPart,
    dayPartResolved: resolveAppointmentDayPart(a),
    internalFixedStart:
      a?.internalFixedPin || a?.internalFixedStart || a?.internalFixedStartTime || null,
    status: cleanString(a?.status),
  }));
  console.info(tag, JSON.stringify({ count: rows.length, appointments: rows }));
}

export function logRouteOptimizeResult(orderContactIds, appointments, tag = 'route_optimize_result') {
  const byId = new Map(
    (Array.isArray(appointments) ? appointments : [])
      .map((a) => [cleanString(a.contactId), a])
      .filter(([id]) => id)
  );
  const stops = (Array.isArray(orderContactIds) ? orderContactIds : []).map((id, idx) => {
    const cid = cleanString(id);
    const a = byId.get(cid);
    return {
      stop: idx + 1,
      contactId: cid,
      timeSlot: a ? cleanString(a.timeSlot) : null,
      timeWindow: a?.timeWindow != null ? String(a.timeWindow) : null,
      dayPartResolved: a ? resolveAppointmentDayPart(a) : null,
    };
  });
  console.info(tag, JSON.stringify({ orderContactIds: stops.map((s) => s.contactId), stops }));
}
