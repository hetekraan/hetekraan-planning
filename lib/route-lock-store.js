/**
 * Centrale route-lock per locatie + datum (planner) in Upstash Redis.
 * Doel: één bron van waarheid over routevolgorde + ETA's over devices heen.
 */

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const PREFIX = 'hk:route_lock';

let _redis = /** @type {Redis | null | undefined} */ (undefined);

function redisPrefix() {
  return String(process.env.REDIS_KEY_PREFIX || 'prod:');
}

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
  return `${redisPrefix()}${PREFIX}:${String(locationId || '').trim()}:${String(dateStr || '').trim()}`;
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
function normalizeInternalFixedEntry(value) {
  if (value && typeof value === 'object') {
    const type = String(value.type || '').trim().toLowerCase();
    const time = String(value.time || '').trim().replace(/^~/, '');
    if ((type === 'exact' || type === 'after' || type === 'before') && /^\d{2}:\d{2}$/.test(time)) {
      return { type, time };
    }
    return null;
  }
  const legacy = String(value || '').trim().replace(/^~/, '');
  if (!legacy || !/^\d{2}:\d{2}$/.test(legacy)) return null;
  return { type: 'exact', time: legacy };
}

function normalizeInternalFixedMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const cid = String(k || '').trim();
    const pin = normalizeInternalFixedEntry(v);
    if (!cid || !pin) continue;
    out[cid] = pin;
  }
  return out;
}

function normalizeRouteLockPayload(input) {
  if (!input || typeof input !== 'object') return null;
  const prevRevision = Number(input.revision);
  const revision = Number.isFinite(prevRevision) && prevRevision >= 0 ? Math.floor(prevRevision) : 0;
  const locked = input.locked === true;
  if (!locked) {
    return {
      locked: false,
      revision,
      orderChecksum: null,
      updatedAt: Date.now(),
      updatedBy: String(input.updatedBy || '').trim() || null,
    };
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
  const orderChecksum = crypto
    .createHash('sha256')
    .update(orderContactIds.join('|'), 'utf8')
    .digest('hex');
  return {
    locked: true,
    revision,
    orderChecksum,
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
  const existing = await getRouteLock(loc, ds);
  const existingRevision = Number(existing?.revision);
  const currentRevision = Number.isFinite(existingRevision) && existingRevision >= 0 ? Math.floor(existingRevision) : 0;
  const expectedRevisionRaw = payload && typeof payload === 'object' ? payload.expectedRevision : undefined;
  if (expectedRevisionRaw !== undefined && expectedRevisionRaw !== null) {
    const expected = Number(expectedRevisionRaw);
    if (!Number.isFinite(expected) || expected < 0) return { ok: false, code: 'BAD_EXPECTED_REVISION' };
    if (Math.floor(expected) !== currentRevision) {
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        currentLock: existing || { locked: false, revision: currentRevision, orderChecksum: null },
      };
    }
  }
  const next = {
    ...normalized,
    revision: currentRevision + 1,
  };
  await redis.set(k, JSON.stringify(next));
  return { ok: true, lock: next };
}
