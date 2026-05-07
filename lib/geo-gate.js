import { blockCentroid, estimateDriveMinutes, haversineKm } from './geo-utils.js';
import { maxCustomerAppointmentsPerDay } from './calendar-customer-cap.js';

function envNumber(name, fallback) {
  const raw = process.env[name];
  const v = Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(v) ? v : fallback;
}

const DEPOT_MAX_MIN = envNumber('PROPOSAL_DEPOT_MAX_MIN', 60);
const BLOCK_RADIUS_KM = envNumber('PROPOSAL_BLOCK_RADIUS_KM', 15);
const LOW_DENSITY_BLOCK_RADIUS_KM = envNumber('PROPOSAL_LOW_DENSITY_BLOCK_RADIUS_KM', 25);
const BLOCK_TRANSITION_MIN = envNumber('PROPOSAL_BLOCK_TRANSITION_MIN', 30);
const SPOED_RADIUS_MULTIPLIER = 2.0;

const DEPOT = { lat: 52.3676, lng: 4.9041 };

function cleanCoords(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((c) => ({ lat: Number(c?.lat), lng: Number(c?.lng) }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
}

/**
 * Harde geo-gate voor slotvoorstellen.
 * @param {{ lat: number, lng: number } | null} newCoord
 * @param {{ morning: Array<{lat:number,lng:number}>, afternoon: Array<{lat:number,lng:number}>, targetBlock: 'morning' | 'afternoon' }} dayContext
 * @param {boolean} [spoedMode=false]
 * @returns {{ valid: boolean, reason: string }}
 */
export function isGeoValid(newCoord, dayContext, spoedMode = false) {
  // A) backwards-compatible: geen coord = geen blokkade
  if (!newCoord) return { valid: true, reason: 'no-coord-skip' };

  const nextCoord = {
    lat: Number(newCoord.lat),
    lng: Number(newCoord.lng),
  };
  if (!Number.isFinite(nextCoord.lat) || !Number.isFinite(nextCoord.lng)) {
    return { valid: true, reason: 'no-coord-skip' };
  }

  const morning = cleanCoords(dayContext?.morning);
  const afternoon = cleanCoords(dayContext?.afternoon);
  const targetBlock = dayContext?.targetBlock === 'afternoon' ? 'afternoon' : 'morning';
  const targetCoords = targetBlock === 'morning' ? morning : afternoon;
  const otherCoords = targetBlock === 'morning' ? afternoon : morning;
  const dayCustomerCapacity = Math.max(1, Number(maxCustomerAppointmentsPerDay()) || 7);
  const existingCount = morning.length + afternoon.length;
  const dayLoadPct = existingCount / dayCustomerCapacity;
  const lowDensityTargetBlock = targetCoords.length <= 1;
  const hasMorningAndAfternoon = morning.length > 0 && afternoon.length > 0;
  const effectiveBlockRadius = spoedMode
    ? Math.max(BLOCK_RADIUS_KM, lowDensityTargetBlock ? LOW_DENSITY_BLOCK_RADIUS_KM : BLOCK_RADIUS_KM) * SPOED_RADIUS_MULTIPLIER
    : Math.max(BLOCK_RADIUS_KM, lowDensityTargetBlock ? LOW_DENSITY_BLOCK_RADIUS_KM : BLOCK_RADIUS_KM);
  const effectiveTransition = spoedMode
    ? BLOCK_TRANSITION_MIN * SPOED_RADIUS_MULTIPLIER
    : BLOCK_TRANSITION_MIN;
  const effectiveDepot = spoedMode
    ? DEPOT_MAX_MIN * SPOED_RADIUS_MULTIPLIER
    : DEPOT_MAX_MIN;

  // B) lege dag: depot check
  if (morning.length === 0 && afternoon.length === 0) {
    const depotMin = estimateDriveMinutes(haversineKm(DEPOT, nextCoord));
    if (depotMin > effectiveDepot) return { valid: false, reason: 'depot-too-far' };
  }

  // C) target block centroid radius check
  const targetCentroid = blockCentroid(targetCoords);
  if (targetCentroid) {
    const km = haversineKm(targetCentroid, nextCoord);
    if (km > effectiveBlockRadius) return { valid: false, reason: 'block-centroid-exceeded' };
  }

  // D) ochtend/middag overgang coherentie
  const otherCentroid = blockCentroid(otherCoords);
  const transitionShouldApply = (hasMorningAndAfternoon || dayLoadPct > 0.5) && targetCoords.length >= 2;
  if (otherCentroid && transitionShouldApply) {
    const transitionFrom = targetCentroid || nextCoord;
    const transitionMin = estimateDriveMinutes(haversineKm(transitionFrom, otherCentroid));
    if (transitionMin > effectiveTransition) {
      return { valid: false, reason: 'transition-too-far' };
    }
  }

  return { valid: true, reason: 'ok' };
}
