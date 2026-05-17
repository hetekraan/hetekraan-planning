/**
 * Per-dag instellingen voor automatische ochtendmeldingen (Upstash Redis).
 */

import { Redis } from '@upstash/redis';

const PREFIX = 'hk:morning_message_settings';

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

export function isMorningMessageStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '').trim());
}

function cleanString(value) {
  return String(value || '').trim();
}

export function morningMessageSettingsKey(locationId, dateStr) {
  return `${PREFIX}:${cleanString(locationId)}:${cleanString(dateStr)}`;
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return defaultMorningMessageSettings();
  }
  const enabled = raw.enabled !== false;
  const lastSentAtRaw = raw.lastSentAt;
  const lastSentAt =
    lastSentAtRaw == null || lastSentAtRaw === ''
      ? null
      : Number.isFinite(Number(lastSentAtRaw)) && Number(lastSentAtRaw) > 0
        ? Math.floor(Number(lastSentAtRaw))
        : null;
  const lastSentRevisionRaw = raw.lastSentRevision;
  const lastSentRevision =
    lastSentRevisionRaw == null || lastSentRevisionRaw === ''
      ? null
      : Number.isFinite(Number(lastSentRevisionRaw)) && Number(lastSentRevisionRaw) >= 0
        ? Math.floor(Number(lastSentRevisionRaw))
        : null;
  const messageCountRaw = raw.messageCount;
  const messageCount =
    messageCountRaw == null || messageCountRaw === ''
      ? null
      : Number.isFinite(Number(messageCountRaw)) && Number(messageCountRaw) >= 0
        ? Math.floor(Number(messageCountRaw))
        : null;
  const lastSentBy = cleanString(raw.lastSentBy) || null;
  const lastSentContactIds = Array.isArray(raw.lastSentContactIds)
    ? raw.lastSentContactIds.map((x) => cleanString(x)).filter(Boolean)
    : [];
  const lastSentWindowsByContactId =
    raw.lastSentWindowsByContactId && typeof raw.lastSentWindowsByContactId === 'object'
      ? raw.lastSentWindowsByContactId
      : {};
  return {
    enabled,
    lastSentAt,
    lastSentRevision,
    lastSentBy,
    messageCount,
    lastSentContactIds,
    lastSentWindowsByContactId,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Math.floor(Number(raw.updatedAt)) : null,
    updatedBy: cleanString(raw.updatedBy) || null,
  };
}

export function defaultMorningMessageSettings() {
  return {
    enabled: true,
    lastSentAt: null,
    lastSentRevision: null,
    lastSentBy: null,
    messageCount: null,
    lastSentContactIds: [],
    lastSentWindowsByContactId: {},
    updatedAt: null,
    updatedBy: null,
  };
}

export async function getMorningMessageSettings(locationId, dateStr) {
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc || !isValidDateStr(ds)) {
    return { ok: false, code: 'BAD_INPUT', settings: defaultMorningMessageSettings() };
  }
  const redis = getRedis();
  if (!redis) {
    return { ok: true, configured: false, settings: defaultMorningMessageSettings() };
  }
  try {
    const raw = await redis.get(morningMessageSettingsKey(loc, ds));
    if (!raw) {
      return { ok: true, configured: true, settings: defaultMorningMessageSettings() };
    }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ok: true, configured: true, settings: normalizeSettings(parsed) };
  } catch (err) {
    return {
      ok: false,
      code: 'REDIS_READ_FAILED',
      error: err?.message || String(err),
      settings: defaultMorningMessageSettings(),
    };
  }
}

export async function setMorningMessageEnabled(locationId, dateStr, enabled, updatedBy) {
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc || !isValidDateStr(ds)) {
    return { ok: false, code: 'BAD_INPUT' };
  }
  const redis = getRedis();
  if (!redis) {
    return { ok: false, code: 'REDIS_NOT_CONFIGURED' };
  }
  const current = await getMorningMessageSettings(loc, ds);
  const next = {
    ...(current.settings || defaultMorningMessageSettings()),
    enabled: enabled !== false,
    updatedAt: Date.now(),
    updatedBy: cleanString(updatedBy) || null,
  };
  try {
    await redis.set(morningMessageSettingsKey(loc, ds), JSON.stringify(next));
    return { ok: true, settings: next };
  } catch (err) {
    return { ok: false, code: 'REDIS_WRITE_FAILED', error: err?.message || String(err) };
  }
}

export async function recordMorningMessagesSent(locationId, dateStr, { revision, count, by, contactIds, windowsByContactId }) {
  const loc = cleanString(locationId);
  const ds = cleanString(dateStr);
  if (!loc || !isValidDateStr(ds)) {
    return { ok: false, code: 'BAD_INPUT' };
  }
  const redis = getRedis();
  if (!redis) {
    return { ok: false, code: 'REDIS_NOT_CONFIGURED' };
  }
  const current = await getMorningMessageSettings(loc, ds);
  const prev = current.settings || defaultMorningMessageSettings();
  const rev =
    revision == null || revision === ''
      ? prev.lastSentRevision
      : Number.isFinite(Number(revision)) && Number(revision) >= 0
        ? Math.floor(Number(revision))
        : prev.lastSentRevision;
  const n =
    count == null || count === ''
      ? prev.messageCount
      : Number.isFinite(Number(count)) && Number(count) >= 0
        ? Math.floor(Number(count))
        : prev.messageCount;
  const next = {
    ...prev,
    enabled: prev.enabled !== false,
    lastSentAt: Date.now(),
    lastSentRevision: rev,
    lastSentBy: cleanString(by) || null,
    messageCount: n,
    lastSentContactIds: Array.isArray(contactIds)
      ? contactIds.map((x) => cleanString(x)).filter(Boolean)
      : prev.lastSentContactIds,
    lastSentWindowsByContactId:
      windowsByContactId && typeof windowsByContactId === 'object'
        ? windowsByContactId
        : prev.lastSentWindowsByContactId,
    updatedAt: Date.now(),
    updatedBy: cleanString(by) || null,
  };
  try {
    await redis.set(morningMessageSettingsKey(loc, ds), JSON.stringify(next));
    return { ok: true, settings: next };
  } catch (err) {
    return { ok: false, code: 'REDIS_WRITE_FAILED', error: err?.message || String(err) };
  }
}
