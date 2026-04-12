/**
 * "Dag is vol" — klanten kunnen die Amsterdam-datum niet meer online boeken / suggesties krijgen,
 * zonder GHL-blokslot. Zelfde Upstash Redis als block-reservation-store.
 */

import { Redis } from '@upstash/redis';

const PREFIX = 'hk:customer_day_full';

let _redis = /** @type {Redis | null | undefined} */ (undefined);

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) {
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export function isCustomerDayFullStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function key(locationId, dateStr) {
  return `${PREFIX}:${String(locationId).trim()}:${String(dateStr).trim()}`;
}

/** @param {string} locationId @param {string} dateStr YYYY-MM-DD */
export async function getCustomerDayFullFlag(locationId, dateStr) {
  const r = getRedis();
  if (!r) return false;
  const ds = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return false;
  const loc = String(locationId || '').trim();
  if (!loc) return false;
  const v = await r.get(key(loc, ds));
  return v === '1' || v === 1 || v === true;
}

/**
 * @param {string} locationId
 * @param {string} dateStr
 * @param {boolean} active
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export async function setCustomerDayFullFlag(locationId, dateStr, active) {
  const r = getRedis();
  if (!r) return { ok: false, code: 'NO_REDIS' };
  const ds = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return { ok: false, code: 'BAD_DATE' };
  const loc = String(locationId || '').trim();
  if (!loc) return { ok: false, code: 'NO_LOCATION' };
  const k = key(loc, ds);
  if (active) {
    await r.set(k, '1');
  } else {
    await r.del(k);
  }
  return { ok: true };
}
