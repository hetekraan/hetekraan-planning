/**
 * Centrale live route-state per locatie + datum in Upstash Redis.
 * De route is geen lock meer: elke dag heeft een centrale live route-state.
 */

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

export const ROUTE_LIVE_SCHEMA_VERSION = 1;

const PREFIX = 'hk:route_live';
const LEGACY_ROUTE_LOCK_PREFIX = 'hk:route_lock';
const ROUTE_LIVE_CAS_SCRIPT = `
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

if raw and expected == "" then
  return {0, "EXPECTED_REVISION_REQUIRED", currentRevision, raw}
end

if expected ~= "" then
  local expectedNumber = tonumber(expected)
  if not expectedNumber or math.floor(expectedNumber) ~= currentRevision then
    return {0, "REVISION_CONFLICT", currentRevision, raw or ""}
  end
end

local okPayload, nextRoute = pcall(cjson.decode, payload)
if not okPayload or type(nextRoute) ~= "table" then
  return {0, "BAD_PAYLOAD_JSON", currentRevision, raw or ""}
end

nextRoute["revision"] = currentRevision + 1
local encoded = cjson.encode(nextRoute)
redis.call("SET", KEYS[1], encoded)
return {1, "OK", currentRevision + 1, encoded}
`;

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

export function isRouteLiveStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '').trim());
}

export function routeLiveKey(locationId, dateStr) {
  return `${PREFIX}:${String(locationId || '').trim()}:${String(dateStr || '').trim()}`;
}

function legacyRouteLockKey(locationId, dateStr) {
  return `${LEGACY_ROUTE_LOCK_PREFIX}:${String(locationId || '').trim()}:${String(dateStr || '').trim()}`;
}

function normalizeTimeStr(value) {
  const s = String(value || '').trim().replace(/^~/, '');
  return /^\d{2}:\d{2}$/.test(s) ? s : '';
}

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeContactIdList(raw) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    const id = cleanString(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeEtasMap(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return {};
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const contactId = cleanString(key);
    const eta = normalizeTimeStr(value);
    if (!contactId || !eta || (allowed && !allowed.has(contactId))) continue;
    out[contactId] = eta;
  }
  return out;
}

function normalizeInternalFixedEntry(value) {
  if (value && typeof value === 'object') {
    const type = cleanString(value.type).toLowerCase();
    const time = normalizeTimeStr(value.time);
    if ((type === 'exact' || type === 'after' || type === 'before') && time) {
      return { type, time };
    }
    return null;
  }
  const legacyTime = normalizeTimeStr(value);
  return legacyTime ? { type: 'exact', time: legacyTime } : null;
}

function normalizeInternalFixedMap(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return {};
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const contactId = cleanString(key);
    const pin = normalizeInternalFixedEntry(value);
    if (!contactId || !pin || (allowed && !allowed.has(contactId))) continue;
    out[contactId] = pin;
  }
  return out;
}

function normalizePinsMap(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return {};
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const contactId = cleanString(key);
    if (!contactId || (allowed && !allowed.has(contactId)) || !value || typeof value !== 'object') continue;
    const type = cleanString(value.type).toLowerCase();
    if (type !== 'manual_order') continue;
    const createdAt = Number(value.createdAt);
    out[contactId] = {
      type: 'manual_order',
      anchor: cleanString(value.anchor) || null,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
      createdBy: cleanString(value.createdBy) || null,
    };
  }
  return out;
}

function normalizeEtaSentMap(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return {};
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const contactId = cleanString(key);
    if (!contactId || (allowed && !allowed.has(contactId))) continue;
    const eta =
      typeof value === 'string'
        ? normalizeTimeStr(value)
        : normalizeTimeStr(value && typeof value === 'object' ? value.eta : '');
    if (!eta) continue;
    const sentAt = Number(value && typeof value === 'object' ? value.sentAt : 0);
    out[contactId] = {
      eta,
      sentAt: Number.isFinite(sentAt) && sentAt > 0 ? Math.floor(sentAt) : Date.now(),
    };
  }
  return out;
}

function normalizeNonNegativeTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function routeOrderChecksum(orderContactIds) {
  return crypto.createHash('sha256').update(orderContactIds.join('|'), 'utf8').digest('hex');
}

export function routeInputFingerprintFromAppointments(appointments) {
  const rows = (Array.isArray(appointments) ? appointments : [])
    .filter((a) => a?.contactId && !a?.isCalBlock && String(a?.status || '').trim().toLowerCase() !== 'klaar')
    .map((a) => {
      const contactId = cleanString(a.contactId);
      const address = cleanString(a.fullAddressLine || a.address);
      const slot = cleanString(a.timeWindow || a.timeSlot || a.slotLabel);
      const jobType = cleanString(a.jobType || a.type).toLowerCase();
      const dayPart = a.dayPart === null || a.dayPart === undefined ? '' : String(a.dayPart);
      const fixed = normalizeInternalFixedEntry(a.internalFixedPin || a.internalFixedStart || a.internalFixedStartTime);
      return JSON.stringify({ contactId, address, slot, jobType, dayPart, fixed });
    })
    .sort();
  return crypto.createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
}

export function normalizeRouteLivePayload(input) {
  if (!input || typeof input !== 'object') return null;
  const schemaVersion = Number(input.schemaVersion);
  if (schemaVersion !== ROUTE_LIVE_SCHEMA_VERSION) return null;
  const dateStr = cleanString(input.dateStr);
  if (!isValidDateStr(dateStr)) return null;
  const routeStatus = cleanString(input.routeStatus || 'live');
  if (!['live', 'optimizing', 'stale', 'error'].includes(routeStatus)) return null;
  const orderContactIds = normalizeContactIdList(input.orderContactIds);
  const revision = normalizeNonNegativeTimestamp(input.revision);
  const etasByContactId = normalizeEtasMap(input.etasByContactId, orderContactIds);
  const pinsByContactId = normalizePinsMap(input.pinsByContactId, orderContactIds);
  const internalFixedStartByContactId = normalizeInternalFixedMap(input.internalFixedStartByContactId, orderContactIds);
  const etaSentIds = new Set(orderContactIds);
  for (const key of Object.keys(input.etaSentByContactId || {})) {
    const id = cleanString(key);
    if (id) etaSentIds.add(id);
  }
  const etaSentByContactId = normalizeEtaSentMap(input.etaSentByContactId, [...etaSentIds]);
  const now = Date.now();
  return {
    schemaVersion: ROUTE_LIVE_SCHEMA_VERSION,
    dateStr,
    revision,
    routeStatus,
    orderContactIds,
    orderChecksum: routeOrderChecksum(orderContactIds),
    etasByContactId,
    pinsByContactId,
    internalFixedStartByContactId,
    etaSentByContactId,
    lastOptimizedAt: normalizeNonNegativeTimestamp(input.lastOptimizedAt),
    lastRouteInputChangedAt: normalizeNonNegativeTimestamp(input.lastRouteInputChangedAt),
    routeInputFingerprint: cleanString(input.routeInputFingerprint) || null,
    optimizerVersion: cleanString(input.optimizerVersion) || 'partitioned-day-v1',
    updatedAt: normalizeNonNegativeTimestamp(input.updatedAt) || now,
    updatedBy: cleanString(input.updatedBy) || null,
    source: cleanString(input.source) || 'unknown',
    migratedFromLegacy: input.migratedFromLegacy === true,
  };
}

function parseStoredRouteLive(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return normalizeRouteLivePayload(raw);
  try {
    return normalizeRouteLivePayload(JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

function currentRouteFromRaw(raw, revision) {
  const parsed = parseStoredRouteLive(raw);
  if (parsed) return parsed;
  const rev = Number(revision);
  return {
    schemaVersion: ROUTE_LIVE_SCHEMA_VERSION,
    routeStatus: 'live',
    revision: Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0,
    orderContactIds: [],
    orderChecksum: routeOrderChecksum([]),
  };
}

function normalizeExpectedRevision(payload) {
  const raw = payload && typeof payload === 'object' ? payload.expectedRevision : undefined;
  if (raw === undefined || raw === null) return { ok: true, hasExpectedRevision: false, expectedRevision: null };
  const expected = Number(raw);
  if (!Number.isFinite(expected) || expected < 0) return { ok: false };
  return { ok: true, hasExpectedRevision: true, expectedRevision: Math.floor(expected) };
}

async function setRouteLiveAtomicCas(redis, key, payload, normalized) {
  const expected = normalizeExpectedRevision(payload);
  if (!expected.ok) return { ok: false, code: 'BAD_EXPECTED_REVISION' };
  const expectedArg = expected.hasExpectedRevision ? String(expected.expectedRevision) : '';
  const result = await redis.eval(ROUTE_LIVE_CAS_SCRIPT, [key], [expectedArg, JSON.stringify(normalized)]);
  const parts = Array.isArray(result) ? result : [];
  const okFlag = parts[0] === 1 || parts[0] === '1';
  const code = cleanString(parts[1]);
  const revision = Number(parts[2]);
  const rawRoute = parts[3];

  if (okFlag) {
    const routeState = parseStoredRouteLive(rawRoute);
    if (!routeState) return { ok: false, code: 'BAD_ROUTE_RESPONSE' };
    return { ok: true, routeState };
  }

  if (code === 'EXPECTED_REVISION_REQUIRED' || code === 'REVISION_CONFLICT') {
    return {
      ok: false,
      code,
      currentRoute: currentRouteFromRaw(rawRoute, revision),
    };
  }

  if (code === 'BAD_PAYLOAD_JSON') {
    console.error('[route-live-store] internal payload encoding error', JSON.stringify({ revision }));
    return { ok: false, code: 'INTERNAL_PAYLOAD_ENCODING_ERROR' };
  }

  return { ok: false, code: code || 'ROUTE_LIVE_CAS_FAILED' };
}

export async function getRouteLiveState(locationId, dateStr) {
  const redis = getRedis();
  if (!redis) return null;
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc || !isValidDateStr(ds)) return null;
  const raw = await redis.get(routeLiveKey(loc, ds));
  return parseStoredRouteLive(raw);
}

async function getLegacyRouteLockState(locationId, dateStr) {
  const redis = getRedis();
  if (!redis) return null;
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc || !isValidDateStr(ds)) return null;
  const raw = await redis.get(legacyRouteLockKey(loc, ds));
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ ok: boolean, code?: string, routeState?: object|null, currentRoute?: object|null }>}
 */
export async function setRouteLiveState(locationId, dateStr, payload) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'NO_REDIS' };
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc) return { ok: false, code: 'NO_LOCATION' };
  if (!isValidDateStr(ds)) return { ok: false, code: 'BAD_DATE' };
  const normalized = normalizeRouteLivePayload({ ...payload, dateStr: ds });
  if (!normalized) return { ok: false, code: 'BAD_PAYLOAD' };
  return setRouteLiveAtomicCas(redis, routeLiveKey(loc, ds), payload, normalized);
}

function routeLivePayloadFromLegacyLock(locationId, dateStr, legacyLock, appointments) {
  const activeContactIds = new Set(
    (Array.isArray(appointments) ? appointments : [])
      .filter((a) => a?.contactId && !a?.isCalBlock && cleanString(a?.status).toLowerCase() !== 'klaar')
      .map((a) => cleanString(a.contactId))
      .filter(Boolean)
  );
  const orderContactIds = normalizeContactIdList(legacyLock?.orderContactIds).filter((id) =>
    activeContactIds.has(id)
  );
  if (!orderContactIds.length) return null;
  const now = Date.now();
  return {
    schemaVersion: ROUTE_LIVE_SCHEMA_VERSION,
    dateStr,
    routeStatus: 'live',
    orderContactIds,
    etasByContactId: normalizeEtasMap(legacyLock?.etasByContactId, orderContactIds),
    pinsByContactId: normalizePinsMap(legacyLock?.pinsByContactId, orderContactIds),
    internalFixedStartByContactId: normalizeInternalFixedMap(legacyLock?.internalFixedStartByContactId, orderContactIds),
    lastOptimizedAt: now,
    lastRouteInputChangedAt: now,
    routeInputFingerprint: routeInputFingerprintFromAppointments(appointments),
    optimizerVersion: 'partitioned-day-v1',
    updatedAt: now,
    updatedBy: cleanString(legacyLock?.updatedBy) || 'migration',
    source: 'migrated_route_lock',
    migratedFromLegacy: true,
  };
}

function routeLivePayloadFromAppointments(dateStr, appointments) {
  const active = (Array.isArray(appointments) ? appointments : [])
    .filter((a) => a?.contactId && !a?.isCalBlock && cleanString(a?.status).toLowerCase() !== 'klaar');
  const orderContactIds = normalizeContactIdList(active.map((a) => a.contactId));
  const etasByContactId = {};
  const internalFixedStartByContactId = {};
  for (const a of active) {
    const cid = cleanString(a.contactId);
    if (!cid) continue;
    const eta = normalizeTimeStr(a.timeSlot || a.plannedTime || a.eta);
    if (eta) etasByContactId[cid] = eta;
    const fixed = normalizeInternalFixedEntry(a.internalFixedPin || a.internalFixedStart || a.internalFixedStartTime);
    if (fixed) internalFixedStartByContactId[cid] = fixed;
  }
  const now = Date.now();
  return {
    schemaVersion: ROUTE_LIVE_SCHEMA_VERSION,
    dateStr,
    routeStatus: 'live',
    orderContactIds,
    etasByContactId,
    internalFixedStartByContactId,
    lastOptimizedAt: 0,
    lastRouteInputChangedAt: now,
    routeInputFingerprint: routeInputFingerprintFromAppointments(appointments),
    optimizerVersion: 'partitioned-day-v1',
    updatedAt: now,
    updatedBy: 'system',
    source: 'initialized_from_appointments',
    migratedFromLegacy: false,
  };
}

/**
 * Ensures a central live route exists for the day.
 * If no live key exists, migrate a legacy locked route or seed from current non-klaar appointments.
 */
export async function ensureRouteLiveState(locationId, dateStr, appointments) {
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc) return { ok: false, code: 'NO_LOCATION' };
  if (!isValidDateStr(ds)) return { ok: false, code: 'BAD_DATE' };

  const existing = await getRouteLiveState(loc, ds);
  if (existing) return { ok: true, routeState: existing, created: false, migratedFromLegacy: false };

  const legacyLock = await getLegacyRouteLockState(loc, ds);
  let payload = null;
  if (legacyLock?.locked === true) {
    payload = routeLivePayloadFromLegacyLock(loc, ds, legacyLock, appointments);
    if (!payload) {
      console.info(
        'route_live_migration_legacy_empty_after_filter',
        JSON.stringify({
          locationId: loc,
          dateStr: ds,
          legacyOrderLen: Array.isArray(legacyLock.orderContactIds) ? legacyLock.orderContactIds.length : 0,
        })
      );
    }
  }
  if (!payload) {
    payload = routeLivePayloadFromAppointments(ds, appointments);
  }
  if (!payload) return { ok: false, code: 'BAD_INITIAL_ROUTE_PAYLOAD' };

  const out = await setRouteLiveState(loc, ds, payload);
  if (out.ok) {
    return {
      ok: true,
      routeState: out.routeState,
      created: true,
      migratedFromLegacy: payload.migratedFromLegacy === true,
    };
  }

  if (out.code === 'EXPECTED_REVISION_REQUIRED' || out.code === 'REVISION_CONFLICT') {
    const current = await getRouteLiveState(loc, ds);
    if (current) return { ok: true, routeState: current, created: false, migratedFromLegacy: false };
  }

  return out;
}
