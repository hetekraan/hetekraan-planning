/**
 * Ochtend (dayPart 0) vóór middag (dayPart 1) in route-volgorde.
 * dayPart-resolutie sluit aan op planner (`dayPart === 0`) en mapEnrichedGhlEventToAppointment.
 */

function cleanString(value) {
  return String(value || '').trim();
}

function hourInAmsterdamFromMs(ms) {
  return parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(ms)),
    10
  );
}

function dayPartFromSlotLabel(value) {
  const s = String(value || '').toLowerCase();
  if (!s) return null;
  if (s.includes('13:00–17:00') || s.includes('13:00-17:00') || s.includes('middag')) return 1;
  if (s.includes('09:00–13:00') || s.includes('09:00-13:00') || s.includes('ochtend')) return 0;
  return null;
}

/** @returns {0|1} */
export function resolveAppointmentDayPart(appt) {
  if (!appt || typeof appt !== 'object') return 1;
  if (appt.dayPart === 0 || appt.dayPart === '0') return 0;
  if (appt.dayPart === 1 || appt.dayPart === '1') return 1;

  for (const field of [appt.timeWindow, appt.slotLabel, appt.timeSlot]) {
    const fromLabel = dayPartFromSlotLabel(field);
    if (fromLabel !== null) return fromLabel;
  }

  const startMs = Number(appt.startMs);
  if (Number.isFinite(startMs) && startMs > 0) {
    return hourInAmsterdamFromMs(startMs) < 13 ? 0 : 1;
  }

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
 * True als actieve stops in orderContactIds niet alle ochtend vóór middag hebben.
 */
export function routeOrderViolatesMorningBeforeAfternoon(orderContactIds, appointments) {
  const activeIds = new Set();
  for (const a of Array.isArray(appointments) ? appointments : []) {
    const cid = cleanString(a?.contactId);
    if (!cid || a?.isCalBlock) continue;
    if (cleanString(a?.status).toLowerCase() === 'klaar') continue;
    activeIds.add(cid);
  }
  if (!activeIds.size) return false;
  const activeInOrder = (Array.isArray(orderContactIds) ? orderContactIds : [])
    .map(cleanString)
    .filter((id) => id && activeIds.has(id));
  if (!activeInOrder.length) return false;
  const enforced = enforceMorningBeforeAfternoonOrder(activeInOrder, appointments);
  return activeInOrder.join('|') !== enforced.join('|');
}

export function logEnforceMorningBeforeAfternoonOrder(
  inputOrder,
  outputOrder,
  appointments,
  tag = '[route-optimizer] enforce_morning_before_afternoon'
) {
  if (inputOrder.join('|') === outputOrder.join('|')) return;
  const byId = new Map(
    (Array.isArray(appointments) ? appointments : [])
      .map((a) => [cleanString(a?.contactId), a])
      .filter(([id]) => id)
  );
  const describe = (ids) =>
    ids.map((id, idx) => {
      const a = byId.get(cleanString(id));
      return {
        stop: idx + 1,
        contactId: cleanString(id),
        dayPartResolved: a ? resolveAppointmentDayPart(a) : null,
      };
    });
  console.info(
    tag,
    JSON.stringify({
      input: describe(inputOrder),
      output: describe(outputOrder),
    })
  );
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

export function logRouteOptimizeInput(appointments, tag = 'route_optimize_input', pinsByContactId = null) {
  const pins = pinsByContactId && typeof pinsByContactId === 'object' ? pinsByContactId : {};
  const rows = (Array.isArray(appointments) ? appointments : []).map((a) => {
    const contactId = cleanString(a?.contactId);
    return {
      contactId,
      timeSlot: cleanString(a?.timeSlot),
      timeWindow: a?.timeWindow != null ? String(a.timeWindow) : null,
      dayPart: a?.dayPart,
      dayPartResolved: resolveAppointmentDayPart(a),
      internalFixedStart:
        a?.internalFixedPin || a?.internalFixedStart || a?.internalFixedStartTime || null,
      status: cleanString(a?.status),
      pinned: contactId ? Boolean(pins[contactId]) : false,
    };
  });
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
