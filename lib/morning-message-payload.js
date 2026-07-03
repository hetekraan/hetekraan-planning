/**
 * Bouwt GHL-payload voor ochtendmeldingen op basis van live route-state.
 */

import {
  CUSTOMER_ARRIVAL_WINDOW_END_MINUTES,
  CUSTOMER_ARRIVAL_WINDOW_HALF_MINUTES,
  CUSTOMER_ARRIVAL_WINDOW_START_MINUTES,
  CUSTOMER_ARRIVAL_WINDOW_WIDTH_MINUTES,
  CUSTOMER_BLOCK_MORNING_START_HOUR,
} from './planning-work-hours.js';
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

/**
 * Klant-aankomstvenster rond de route-ETA: ALTIJD 150 min (2,5u) breed, ETA in het
 * midden (ETA ± 75 min). Kwartier-afgerond. Schuift tegen de randen 09:00 / 18:00
 * (opschuiven, nooit afkappen) zodat de breedte exact 150 min blijft.
 * Omdat 75 een veelvoud van 15 is, blijft de breedte na losse kwartier-afronding 150.
 * @param {number} etaMins
 * @returns {{ fromMins: number, toMins: number }}
 */
export function computeCustomerArrivalWindowFromEta(etaMins) {
  const start = CUSTOMER_ARRIVAL_WINDOW_START_MINUTES;
  const end = CUSTOMER_ARRIVAL_WINDOW_END_MINUTES;
  const width = CUSTOMER_ARRIVAL_WINDOW_WIDTH_MINUTES;
  const half = CUSTOMER_ARRIVAL_WINDOW_HALF_MINUTES;
  let fromMins = roundToQuarterMinutes(etaMins - half);
  let toMins = roundToQuarterMinutes(etaMins + half);
  if (fromMins < start) {
    fromMins = start;
    toMins = start + width;
  }
  if (toMins > end) {
    toMins = end;
    fromMins = end - width;
  }
  return { fromMins, toMins };
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
  const { fromMins, toMins } = computeCustomerArrivalWindowFromEta(etaMins);
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

const TIME_RE = /^\d{1,2}:\d{2}$/;

/**
 * Tekst voor de "Slot"-pill in het planner-overzicht.
 * - timeFrom === timeTo (exact)         -> "Slot om HH:MM"
 * - timeFrom && timeTo (verschillend)   -> "Slot HH:MM-HH:MM" (ASCII hyphen)
 * - alleen plannedValue                 -> "Slot om HH:MM"
 * - niets bruikbaars                    -> ""
 * @param {{ timeFrom?: string, timeTo?: string, plannedValue?: string }|null|undefined} win
 */
export function formatMorningWindowPillLabel(win) {
  if (!win || typeof win !== 'object') return '';
  const from = cleanString(win.timeFrom);
  const to = cleanString(win.timeTo);
  if (TIME_RE.test(from) && TIME_RE.test(to)) {
    return from === to ? `Slot om ${from}` : `Slot ${from}-${to}`;
  }
  const planned = cleanString(win.plannedValue);
  if (TIME_RE.test(planned)) return `Slot om ${planned}`;
  return '';
}

/**
 * Tekst voor de bestaande (groene) ETA-pill.
 * @param {string} eta
 */
export function formatEtaSentPillLabel(eta) {
  const v = cleanString(eta);
  return TIME_RE.test(v) ? `ETA ${v}` : 'ETA verstuurd';
}

/**
 * Geef het verstuurde ochtendmelding-venster voor een contact, of null.
 * Toont alleen iets als er daadwerkelijk een ochtendmelding is verstuurd
 * (lastSentAt) waarin dit contact zat én er window-data bestaat.
 * @param {object|null|undefined} settings
 * @param {string} contactId
 */
export function resolveMorningSentWindowForContact(settings, contactId) {
  const cid = cleanString(contactId);
  if (!cid || !settings || typeof settings !== 'object') return null;
  if (!settings.lastSentAt) return null;
  const ids = Array.isArray(settings.lastSentContactIds) ? settings.lastSentContactIds : [];
  if (!ids.map(cleanString).includes(cid)) return null;
  const map =
    settings.lastSentWindowsByContactId && typeof settings.lastSentWindowsByContactId === 'object'
      ? settings.lastSentWindowsByContactId
      : null;
  const win = map ? map[cid] : null;
  if (!win || typeof win !== 'object') return null;
  if (!formatMorningWindowPillLabel(win)) return null;
  return win;
}
