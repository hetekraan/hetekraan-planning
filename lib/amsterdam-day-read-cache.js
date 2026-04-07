/**
 * Process-local read-through cache for Amsterdam-kalenderdag fetches (GHL events, blocked slots, Redis B1 synthetics).
 * TTL is short; writes to GHL/Redis blijven rechtstreeks — alleen reads kunnen stale zijn binnen de TTL.
 */

import { fetchCalendarEventsForDay } from './calendar-customer-cap.js';
import { fetchBlockedSlotsAsEvents } from './ghl-calendar-blocks.js';
import { listConfirmedSyntheticEventsForDate } from './block-reservation-store.js';

/** 30–60s venster; korter = minder stale availability-risk. */
export const AMSTERDAM_DAY_READ_CACHE_TTL_MS = 45_000;

const store = new Map();

function deepClone(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * @param {string} key
 * @returns {unknown|undefined} undefined = miss of verlopen
 */
export function amsterdamDayReadCacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return deepClone(entry.value);
}

export function amsterdamDayReadCacheSet(key, value) {
  store.set(key, {
    value: deepClone(value),
    expiresAt: Date.now() + AMSTERDAM_DAY_READ_CACHE_TTL_MS,
  });
}

/** Ruwe `calendars/events`-lijst (zelfde als fetchCalendarEventsForDay). */
export function amsterdamDayReadCacheKeyCalendarEvents(locationId, calendarId, dateStr) {
  return `hk:day:ce:${locationId}:${calendarId}:${dateStr}`;
}

/** GET blocked-slots als events; start/end ms zijn de daggrenzen. */
export function amsterdamDayReadCacheKeyBlockedSlots(locationId, calendarId, startMs, endMs, assignedUserId) {
  const u = assignedUserId != null && assignedUserId !== '' ? String(assignedUserId) : '_';
  return `hk:day:bs:${locationId}:${calendarId}:${startMs}:${endMs}:${u}`;
}

/** Bevestigde B1-blokreserveringen uit Redis voor die Amsterdam-datum. */
export function amsterdamDayReadCacheKeyRedisSynthetics(dateStr) {
  return `hk:day:rs:${dateStr}`;
}

export async function cachedFetchCalendarEventsForDay(dateStr, ctx) {
  const key = amsterdamDayReadCacheKeyCalendarEvents(ctx.locationId, ctx.calendarId, dateStr);
  const hit = amsterdamDayReadCacheGet(key);
  if (hit !== undefined) return hit;
  const fresh = await fetchCalendarEventsForDay(dateStr, ctx);
  if (fresh !== null) amsterdamDayReadCacheSet(key, fresh);
  return fresh;
}

export async function cachedFetchBlockedSlotsAsEvents(base, ctx, bounds) {
  const { startMs, endMs } = bounds;
  const key = amsterdamDayReadCacheKeyBlockedSlots(
    ctx.locationId,
    ctx.calendarId,
    startMs,
    endMs,
    ctx.assignedUserId
  );
  const hit = amsterdamDayReadCacheGet(key);
  if (hit !== undefined) return hit;
  const fresh = await fetchBlockedSlotsAsEvents(base, {
    locationId: ctx.locationId,
    calendarId: ctx.calendarId,
    startMs,
    endMs,
    apiKey: ctx.apiKey,
    assignedUserId: ctx.assignedUserId,
  });
  amsterdamDayReadCacheSet(key, Array.isArray(fresh) ? fresh : []);
  return fresh;
}

/** Alleen succesvolle Redis-reads worden gecached (geen cache bij throw). */
export async function cachedListConfirmedSyntheticEventsForDate(dateStr) {
  const key = amsterdamDayReadCacheKeyRedisSynthetics(dateStr);
  const hit = amsterdamDayReadCacheGet(key);
  if (hit !== undefined) return hit;
  const fresh = await listConfirmedSyntheticEventsForDate(dateStr);
  const arr = Array.isArray(fresh) ? fresh : [];
  amsterdamDayReadCacheSet(key, arr);
  return arr;
}

/** Na B1-reservering-delete: read-cache legen zodat capacity direct klopt. */
export function invalidateRedisSyntheticsCacheForDate(dateStr) {
  const ds = String(dateStr ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return;
  store.delete(amsterdamDayReadCacheKeyRedisSynthetics(ds));
}
