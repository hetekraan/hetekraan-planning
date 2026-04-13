/**
 * Centrale route-lock per locatie + datum (planner) in Upstash Redis.
 * Doel: één bron van waarheid over routevolgorde + ETA's over devices heen.
 */

import { Redis } from '@upstash/redis';

const PREFIX = 'hk:route_lock';

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

export function isRouteLockStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '').trim());
}

function key(locationId, dateStr) {
  return `${PREFIX}:${String(locationId || '').trim()}:${String(dateStr || '').trim()}`;
}

function normalizeEtasMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const cid = String(k || '').trim();
    const eta = String(v || '').trim().replace(/^~/, '');
    if (!cid || !/^\d{2}:\d{2}$/.test(eta)) continue;
    out[cid] = eta;
  }
  return out;
}

/** Interne vaste start (operationeel, monteur), los van klant-slot. */
function normalizeInternalFixedMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const cid = String(k || '').trim();
    const t = String(v || '').trim().replace(/^~/, '');
    if (!cid || !/^\d{2}:\d{2}$/.test(t)) continue;
    out[cid] = t;
  }
  return out;
}

function normalizeRouteLockPayload(input) {
  if (!input || typeof input !== 'object') return null;
  const locked = input.locked === true;
  if (!locked) {
    return { locked: false, updatedAt: Date.now(), updatedBy: String(input.updatedBy || '').trim() || null };
  }
  const orderContactIds = Array.from(
    new Set(
      (Array.isArray(input.orderContactIds) ? input.orderContactIds : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    )
  );
  if (!orderContactIds.length) return null;
  const internalFixedStartByContactId = normalizeInternalFixedMap(input.internalFixedStartByContactId);
  return {
    locked: true,
    orderContactIds,
    etasByContactId: normalizeEtasMap(input.etasByContactId),
    ...(Object.keys(internalFixedStartByContactId).length ? { internalFixedStartByContactId } : {}),
    updatedAt: Date.now(),
    updatedBy: String(input.updatedBy || '').trim() || null,
  };
}

export async function getRouteLock(locationId, dateStr) {
  const redis = getRedis();
  if (!redis) return null;
  const loc = String(locationId || '').trim();
  const ds = String(dateStr || '').trim();
  if (!loc || !isValidDateStr(ds)) return null;
  const raw = await redis.get(key(loc, ds));
  if (!raw) return null;
  if (typeof raw === 'object') return normalizeRouteLockPayload(raw);
  try {
    return normalizeRouteLockPayload(JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ ok: boolean, code?: string, lock?: object|null }>}
 */
export async function setRouteLock(locationId, dateStr, payload) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'NO_REDIS' };
  const loc = String(locationId || '').trim();
  const ds = String(dateStr || '').trim();
  if (!loc) return { ok: false, code: 'NO_LOCATION' };
  if (!isValidDateStr(ds)) return { ok: false, code: 'BAD_DATE' };
  const normalized = normalizeRouteLockPayload(payload);
  if (!normalized) return { ok: false, code: 'BAD_PAYLOAD' };
  const k = key(loc, ds);
  if (!normalized.locked) {
    await redis.del(k);
    return { ok: true, lock: null };
  }
  await redis.set(k, JSON.stringify(normalized));
  return { ok: true, lock: normalized };
}
