/**
 * Centrale route-lock per locatie + datum (planner) in Upstash Redis.
 * Doel: één bron van waarheid over routevolgorde + ETA's over devices heen.
 */

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const PREFIX = 'hk:route_lock';

let _redis = /** @type {Redis | null | undefined} */ (undefined);

const ROUTE_LOCK_CAS_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
local expected = ARGV[1]
local payload = ARGV[2]
local currentRevision = 0

if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == "table" then
    local rev = tonumber(decoded["revision"])
    if rev and rev >= 0 then
      currentRevision = math.floor(rev)
    end
  end
end

if expected ~= "" then
  local expectedNumber = tonumber(expected)
  if not expectedNumber or math.floor(expectedNumber) ~= currentRevision then
    return {0, "REVISION_CONFLICT", currentRevision, raw or ""}
  end
end

local okPayload, nextLock = pcall(cjson.decode, payload)
if not okPayload or type(nextLock) ~= "table" then
  return {0, "BAD_PAYLOAD_JSON", currentRevision, raw or ""}
end

nextLock["revision"] = currentRevision + 1
local encoded = cjson.encode(nextLock)
redis.call("SET", KEYS[1], encoded)
return {1, "OK", currentRevision + 1, encoded}
`;

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

export function isRouteRefactorEnabled() {
  return String(process.env.ROUTE_REFACTOR_ENABLED || '').trim().toLowerCase() !== 'false';
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

function parseStoredRouteLock(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function currentLockFromRaw(raw, revision) {
  const parsed = parseStoredRouteLock(raw);
  if (parsed) return parsed;
  const rev = Number(revision);
  return {
    locked: false,
    revision: Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0,
    orderChecksum: null,
  };
}

function normalizeExpectedRevision(payload) {
  const expectedRevisionRaw = payload && typeof payload === 'object' ? payload.expectedRevision : undefined;
  if (expectedRevisionRaw === undefined || expectedRevisionRaw === null) {
    return { ok: true, hasExpectedRevision: false, expectedRevision: null };
  }
  const expected = Number(expectedRevisionRaw);
  if (!Number.isFinite(expected) || expected < 0) return { ok: false };
  return { ok: true, hasExpectedRevision: true, expectedRevision: Math.floor(expected) };
}

async function setRouteLockLegacyReadThenWrite(redis, loc, ds, payload, normalized, k) {
  const existing = await getRouteLock(loc, ds);
  const existingRevision = Number(existing?.revision);
  const currentRevision = Number.isFinite(existingRevision) && existingRevision >= 0 ? Math.floor(existingRevision) : 0;
  const expected = normalizeExpectedRevision(payload);
  if (!expected.ok) return { ok: false, code: 'BAD_EXPECTED_REVISION' };
  if (expected.hasExpectedRevision && expected.expectedRevision !== currentRevision) {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      currentLock: existing || { locked: false, revision: currentRevision, orderChecksum: null },
    };
  }
  const next = {
    ...normalized,
    revision: currentRevision + 1,
  };
  await redis.set(k, JSON.stringify(next));
  return { ok: true, lock: next };
}

async function setRouteLockAtomicCas(redis, payload, normalized, k) {
  const expected = normalizeExpectedRevision(payload);
  if (!expected.ok) return { ok: false, code: 'BAD_EXPECTED_REVISION' };
  const expectedArg = expected.hasExpectedRevision ? String(expected.expectedRevision) : '';
  const result = await redis.eval(ROUTE_LOCK_CAS_SCRIPT, [k], [expectedArg, JSON.stringify(normalized)]);
  const parts = Array.isArray(result) ? result : [];
  const okFlag = parts[0] === 1 || parts[0] === '1';
  const code = String(parts[1] || '');
  const revision = Number(parts[2]);
  const rawLock = parts[3];

  if (okFlag) {
    const lock = parseStoredRouteLock(rawLock);
    if (!lock) return { ok: false, code: 'BAD_LOCK_RESPONSE' };
    return { ok: true, lock };
  }

  if (code === 'REVISION_CONFLICT') {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      currentLock: currentLockFromRaw(rawLock, revision),
    };
  }

  return { ok: false, code: code || 'ROUTE_LOCK_CAS_FAILED' };
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

  if (!isRouteRefactorEnabled()) {
    console.warn(
      'ROUTE_REFACTOR_DISABLED',
      JSON.stringify({
        store: 'route-lock',
        action: 'setRouteLock',
        mode: 'legacy_read_then_write',
        dateStr: ds,
      })
    );
    return setRouteLockLegacyReadThenWrite(redis, loc, ds, payload, normalized, k);
  }

  return setRouteLockAtomicCas(redis, payload, normalized, k);
}
