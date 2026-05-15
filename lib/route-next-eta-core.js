/**
 * Volgende-stop + ETA berekening voor onderweg-flow.
 */

import { travelMinutesOneLeg } from '../api/optimize-route.js';
import {
  computeEtaFromTravelMinutes,
  etaDiffMinutes,
  nowMinutesInAmsterdam,
  parseTimeToMinutes,
} from './route-eta-time.js';

const DEPOT_ADDRESS = 'Cornelis Dopperkade, Amsterdam';

function cleanString(value) {
  return String(value || '').trim();
}

function appointmentAddress(a) {
  return cleanString(a?.fullAddressLine || a?.address);
}

function isCalBlockAppointment(a) {
  return Boolean(a?.isCalBlock);
}

function isKlaarAppointment(a) {
  return cleanString(a?.status).toLowerCase() === 'klaar';
}

export function activeRouteContactIds(appointments) {
  const out = new Set();
  for (const a of Array.isArray(appointments) ? appointments : []) {
    const cid = cleanString(a?.contactId);
    if (!cid || isCalBlockAppointment(a) || isKlaarAppointment(a)) continue;
    out.add(cid);
  }
  return out;
}

export function appointmentByContactId(appointments) {
  const map = new Map();
  for (const a of Array.isArray(appointments) ? appointments : []) {
    const cid = cleanString(a?.contactId);
    if (!cid || map.has(cid)) continue;
    map.set(cid, a);
  }
  return map;
}

/** Eerstvolgende niet-klaar contact na currentContactId in route-volgorde. */
export function findNextNonKlaarContactId(orderContactIds, activeIds, afterContactId) {
  const order = Array.isArray(orderContactIds) ? orderContactIds.map(cleanString).filter(Boolean) : [];
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  const startIdx = order.indexOf(cleanString(afterContactId));
  const from = startIdx >= 0 ? startIdx + 1 : 0;
  for (let i = from; i < order.length; i++) {
    const id = order[i];
    if (active.has(id)) return id;
  }
  return null;
}

/** Directe voorganger in route (ook klaar), voor from-adres. */
export function findPreviousContactIdInOrder(orderContactIds, contactId) {
  const order = Array.isArray(orderContactIds) ? orderContactIds.map(cleanString).filter(Boolean) : [];
  const idx = order.indexOf(cleanString(contactId));
  if (idx <= 0) return null;
  return order[idx - 1] || null;
}

export function contactPreviewFromAppointment(appt) {
  if (!appt) return null;
  const id = cleanString(appt.contactId);
  if (!id) return null;
  return {
    id,
    contactId: id,
    name: cleanString(appt.name) || 'Klant',
    address: appointmentAddress(appt),
  };
}

/**
 * @param {{
 *   routeState: object,
 *   appointments: object[],
 *   currentContactId: string,
 *   travelMinutesFn?: (fromAddr: string, toAddr: string) => Promise<number|null>,
 *   mapsKey?: string,
 * }} input
 */
export async function buildNextEtaPreview(input) {
  const routeState = input?.routeState || {};
  const appointments = Array.isArray(input?.appointments) ? input.appointments : [];
  const currentContactId = cleanString(input?.currentContactId);
  const byContact = appointmentByContactId(appointments);
  const currentAppt = byContact.get(currentContactId);
  if (!currentContactId || !currentAppt || isCalBlockAppointment(currentAppt)) {
    return { ok: true, nextContact: null, reason: 'NO_CURRENT_STOP' };
  }

  const order = Array.isArray(routeState.orderContactIds) ? routeState.orderContactIds : [];
  const activeIds = activeRouteContactIds(appointments);
  const nextContactId = findNextNonKlaarContactId(order, activeIds, currentContactId);
  if (!nextContactId) {
    return { ok: true, nextContact: null, reason: 'NO_NEXT_STOP' };
  }

  const nextAppt = byContact.get(nextContactId);
  const nextContact = contactPreviewFromAppointment(nextAppt);
  if (!nextContact) {
    return { ok: true, nextContact: null, reason: 'NO_NEXT_STOP' };
  }

  const fromAddr = appointmentAddress(currentAppt);
  const toAddr = nextContact.address;
  if (!fromAddr || !toAddr) {
    console.warn(
      '[route-next-eta] missing_address_for_preview',
      JSON.stringify({ currentContactId, nextContactId, hasFrom: !!fromAddr, hasTo: !!toAddr })
    );
    return { ok: true, nextContact, etaTime: null, code: 'MISSING_ADDRESS' };
  }

  const mapsKey = cleanString(input?.mapsKey || process.env.GOOGLE_MAPS_API_KEY);
  const travelFn =
    input?.travelMinutesFn ||
    (async (from, to) => {
      if (!mapsKey) return null;
      return travelMinutesOneLeg(mapsKey, from, to);
    });

  let travelMinutes;
  try {
    travelMinutes = await travelFn(fromAddr, toAddr);
  } catch (err) {
    console.warn('[route-next-eta] travel_calc_error', err?.message || err);
    travelMinutes = null;
  }

  if (travelMinutes == null || !Number.isFinite(travelMinutes)) {
    return { ok: false, code: 'ETA_CALC_FAILED', nextContact };
  }

  const etaTime = computeEtaFromTravelMinutes(travelMinutes, nowMinutesInAmsterdam());
  return { ok: true, nextContact, etaTime, travelMinutes };
}

/**
 * @param {{
 *   routeState: object,
 *   appointments: object[],
 *   currentContactId: string,
 *   nextContactId: string,
 *   clientEta?: string,
 *   travelMinutesFn?: (fromAddr: string, toAddr: string) => Promise<number|null>,
 *   mapsKey?: string,
 * }} input
 */
export async function resolveSendNextEta(input) {
  const currentContactId = cleanString(input?.currentContactId);
  const nextContactId = cleanString(input?.nextContactId);
  const clientEta = cleanString(input?.clientEta);
  const routeState = input?.routeState || {};
  const appointments = Array.isArray(input?.appointments) ? input.appointments : [];
  const byContact = appointmentByContactId(appointments);
  const activeIds = activeRouteContactIds(appointments);

  if (!nextContactId || !activeIds.has(nextContactId)) {
    return { ok: false, code: 'STALE_CONTACT_ID' };
  }

  const order = Array.isArray(routeState.orderContactIds) ? routeState.orderContactIds : [];
  if (!order.includes(nextContactId)) {
    return { ok: false, code: 'STALE_CONTACT_ID' };
  }

  const fromContactId =
    cleanString(currentContactId) || findPreviousContactIdInOrder(order, nextContactId) || '';
  const fromAppt = fromContactId ? byContact.get(fromContactId) : null;
  const nextAppt = byContact.get(nextContactId);
  const fromAddr = fromAppt ? appointmentAddress(fromAppt) : DEPOT_ADDRESS;
  const toAddr = appointmentAddress(nextAppt);

  if (!toAddr) {
    return { ok: false, code: 'MISSING_ADDRESS' };
  }

  const mapsKey = cleanString(input?.mapsKey || process.env.GOOGLE_MAPS_API_KEY);
  const travelFn =
    input?.travelMinutesFn ||
    (async (from, to) => {
      if (!mapsKey) return null;
      return travelMinutesOneLeg(mapsKey, from, to);
    });

  let serverEta = clientEta;
  try {
    const travelMinutes = await travelFn(fromAddr || DEPOT_ADDRESS, toAddr);
    if (travelMinutes != null && Number.isFinite(travelMinutes)) {
      const computed = computeEtaFromTravelMinutes(travelMinutes, nowMinutesInAmsterdam());
      if (!clientEta || !parseTimeToMinutes(clientEta)) {
        serverEta = computed;
      } else if (etaDiffMinutes(clientEta, computed) > 5) {
        serverEta = computed;
      }
    }
  } catch (err) {
    console.warn('[route-next-eta] travel_calc_error_send', err?.message || err);
  }

  if (!serverEta || !parseTimeToMinutes(serverEta)) {
    return { ok: false, code: 'ETA_CALC_FAILED' };
  }

  return {
    ok: true,
    sentEta: serverEta,
    nextContact: contactPreviewFromAppointment(nextAppt),
    fromContactId: fromContactId || null,
  };
}
