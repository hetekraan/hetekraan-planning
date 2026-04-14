function toRadians(deg) {
  return (Number(deg) * Math.PI) / 180;
}

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY;

/**
 * Vogelvluchtafstand in kilometers via haversine.
 * @param {{ lat: number, lng: number }} coordA
 * @param {{ lat: number, lng: number }} coordB
 * @returns {number}
 */
export function haversineKm(coordA, coordB) {
  if (!coordA || !coordB) return Number.POSITIVE_INFINITY;
  const lat1 = Number(coordA.lat);
  const lon1 = Number(coordA.lng);
  const lat2 = Number(coordB.lat);
  const lon2 = Number(coordB.lng);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const EARTH_RADIUS_KM = 6371;
  return EARTH_RADIUS_KM * c;
}

/**
 * Gemiddelde van een coordinatenlijst.
 * @param {Array<{ lat: number, lng: number }>} coords
 * @returns {{ lat: number, lng: number } | null}
 */
export function blockCentroid(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const clean = coords
    .map((c) => ({ lat: Number(c?.lat), lng: Number(c?.lng) }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  if (!clean.length) return null;
  const totals = clean.reduce(
    (acc, c) => ({ lat: acc.lat + c.lat, lng: acc.lng + c.lng }),
    { lat: 0, lng: 0 }
  );
  return {
    lat: totals.lat / clean.length,
    lng: totals.lng / clean.length,
  };
}

/**
 * Schatting rijtijd in minuten op basis van km.
 * Formule: (km * 1.35) / (80/60)
 * @param {number} km
 * @returns {number}
 */
export function estimateDriveMinutes(km) {
  const distanceKm = Number(km);
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return Number.POSITIVE_INFINITY;
  const minutes = (distanceKm * 1.35) / (80 / 60);
  return Math.ceil(minutes);
}

/**
 * Geocode helper (Google Geocoding API).
 * @param {string} address
 * @returns {Promise<{lat:number,lng:number}|null>}
 */
export async function geocode(address) {
  try {
    const q = String(address || '').trim();
    if (!q || !MAPS_KEY) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${MAPS_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'OK' && d.results?.[0]?.geometry?.location) {
      const loc = d.results[0].geometry.location;
      if (Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
        return { lat: Number(loc.lat), lng: Number(loc.lng) };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Geocodeer eventlijst op basis van `address` field.
 * @param {Array<{address?: string}>} evList
 * @param {(addressLine:string)=>Promise<{lat:number,lng:number}|null>} [geocodeFn]
 * @returns {Promise<Array<{lat:number,lng:number}>>}
 */
export async function geocodeEvents(evList, geocodeFn = geocode) {
  const coords = [];
  for (const e of Array.isArray(evList) ? evList : []) {
    if (!e?.address) continue;
    const c = await geocodeFn(e.address);
    if (c) coords.push(c);
  }
  return coords;
}
