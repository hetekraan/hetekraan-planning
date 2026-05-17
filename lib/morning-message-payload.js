/**
 * Bouwt GHL-payload voor ochtendmeldingen op basis van live route-state.
 */

import { CUSTOMER_BLOCK_MORNING_START_HOUR } from './planning-work-hours.js';
import { isPlannerAppointmentEligibleForMorningMessage } from './planner-appointment-status.js';

export const DEFAULT_FIRST_ROUTE_START = `${String(CUSTOMER_BLOCK_MORNING_START_HOUR).padStart(2, '0')}:00`;

function cleanString(value) {
  return String(value || '').trim();
}

export function parseTimeToMinutes(hhmm) {
  const s = cleanString(hhmm).replace(/^~/, '');
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function formatMinutesToTime(totalMins) {
  const wrapped = ((Math.floor(totalMins) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function roundToQuarterMinutes(totalMins) {
  return Math.round(Number(totalMins) / 15) * 15;
}

function normalizeInternalFixedEntry(value) {
  if (value && typeof value === 'object') {
    const type = cleanString(value.type).toLowerCase();
    const time = cleanString(value.time).replace(/^~/, '');
    if (type === 'exact' && /^\d{2}:\d{2}$/.test(time)) return { type: 'exact', time };
    return null;
  }
  const legacy = cleanString(value).replace(/^~/, '');
  return /^\d{2}:\d{2}$/.test(legacy) ? { type: 'exact', time: legacy } : null;
}

/** Natuurlijke zin voor WhatsApp {{1}}: "om 09:00" of "tussen 09:30 en 11:30". */
export function buildMorningWindowPhrase({ timeFrom, timeTo, isExactStart }) {
  const from = cleanString(timeFrom);
  const to = cleanString(timeTo);
  if (isExactStart || (from && to && from === to)) {
    return `om ${from || to}`;
  }
  if (from && to) return `tussen ${from} en ${to}`;
  if (from) return `om ${from}`;
  return '';
}

/**
 * @param {{
 *   contactId: string,
 *   orderContactIds: string[],
 *   etasByContactId?: Record<string, string>,
 *   internalFixedStartByContactId?: Record<string, unknown>,
 *   defaultFirstStart?: string,
 * }} input
 */
export function buildMorningWindowForContact(input) {
  const contactId = cleanString(input.contactId);
  const orderContactIds = (Array.isArray(input.orderContactIds) ? input.orderContactIds : [])
    .map(cleanString)
    .filter(Boolean);
  const etasByContactId = input.etasByContactId && typeof input.etasByContactId === 'object' ? input.etasByContactId : {};
  const internalFixedStartByContactId =
    input.internalFixedStartByContactId && typeof input.internalFixedStartByContactId === 'object'
      ? input.internalFixedStartByContactId
      : {};
  const defaultFirstStart = cleanString(input.defaultFirstStart) || DEFAULT_FIRST_ROUTE_START;
  const firstId = orderContactIds[0] || '';

  const pin = normalizeInternalFixedEntry(internalFixedStartByContactId[contactId]);
  if (pin?.type === 'exact' && pin.time) {
    return {
      contactId,
      timeFrom: pin.time,
      timeTo: pin.time,
      plannedValue: pin.time,
      windowPhrase: buildMorningWindowPhrase({ timeFrom: pin.time, timeTo: pin.time, isExactStart: true }),
      isFirstStop: contactId === firstId,
      isExactStart: true,
    };
  }

  if (contactId && contactId === firstId) {
    const exact = defaultFirstStart;
    return {
      contactId,
      timeFrom: exact,
      timeTo: exact,
      plannedValue: exact,
      windowPhrase: buildMorningWindowPhrase({ timeFrom: exact, timeTo: exact, isExactStart: true }),
      isFirstStop: true,
      isExactStart: true,
    };
  }

  const eta = cleanString(etasByContactId[contactId]);
  const etaMins = parseTimeToMinutes(eta);
  if (etaMins == null) {
    return {
      contactId,
      timeFrom: defaultFirstStart,
      timeTo: defaultFirstStart,
      plannedValue: defaultFirstStart,
      windowPhrase: buildMorningWindowPhrase({
        timeFrom: defaultFirstStart,
        timeTo: defaultFirstStart,
        isExactStart: true,
      }),
      isFirstStop: false,
      isExactStart: true,
    };
  }
  const fromMins = roundToQuarterMinutes(etaMins - 60);
  const toMins = roundToQuarterMinutes(etaMins + 60);
  const timeFrom = formatMinutesToTime(fromMins);
  const timeTo = formatMinutesToTime(toMins);
  const startTime = eta || timeFrom;
  return {
    contactId,
    timeFrom,
    timeTo,
    plannedValue: startTime,
    windowPhrase: buildMorningWindowPhrase({ timeFrom, timeTo, isExactStart: false }),
    isFirstStop: false,
    isExactStart: false,
  };
}

/**
 * @param {object|null|undefined} routeState
 * @param {{ defaultFirstStart?: string }} [options]
 */
export function buildMorningMessageAppointmentsFromRouteState(routeState, options = {}) {
  const orderContactIds = Array.isArray(routeState?.orderContactIds)
    ? routeState.orderContactIds.map(cleanString).filter(Boolean)
    : [];
  const etasByContactId =
    routeState?.etasByContactId && typeof routeState.etasByContactId === 'object' ? routeState.etasByContactId : {};
  const internalFixedStartByContactId =
    routeState?.internalFixedStartByContactId && typeof routeState.internalFixedStartByContactId === 'object'
      ? routeState.internalFixedStartByContactId
      : {};

  return orderContactIds.map((contactId) =>
    buildMorningWindowForContact({
      contactId,
      orderContactIds,
      etasByContactId,
      internalFixedStartByContactId,
      defaultFirstStart: options.defaultFirstStart,
    })
  );
}

/**
 * Filter op ingeplande klanten in routevolgorde.
 * @param {object|null|undefined} routeState
 * @param {Array<{ contactId?: string, status?: string }>} appointments
 */
export function buildMorningMessageAppointmentsForIngepland(routeState, appointments) {
  const byContact = new Map();
  for (const a of Array.isArray(appointments) ? appointments : []) {
    const cid = cleanString(a?.contactId);
    if (!cid) continue;
    byContact.set(cid, a);
  }
  const built = buildMorningMessageAppointmentsFromRouteState(routeState);
  return built.filter((row) => {
    const appt = byContact.get(row.contactId);
    return appt && isPlannerAppointmentEligibleForMorningMessage(appt);
  });
}
