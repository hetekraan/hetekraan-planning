/**
 * Model B — blok-boekingen in Upstash Redis (serverless-vriendelijk).
 * pending = invite verstuurd, nog niet bevestigd door klant
 * confirmed = klant heeft bevestigd (B1)
 */

import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { normalizeWorkType, plannedMinutesForType } from './booking-blocks.js';

/** @typedef {'pending'|'confirmed'|'cancelled'} BlockReservationStatus */

/**
 * @typedef {object} BlockReservation
 * @property {string} id — UUID
 * @property {string} contactId — GHL contact id
 * @property {string} dateStr — YYYY-MM-DD (Amsterdam kalenderdag)
 * @property {'morning'|'afternoon'} block
 * @property {string} workType — genormaliseerd (installatie|onderhoud|reparatie)
 * @property {BlockReservationStatus} status
 * @property {number} createdAt — epoch ms
 * @property {number} [updatedAt]
 * @property {number} [confirmedAt]
 * @property {string} [locationId]
 * @property {Record<string, unknown>} [metadata]
 */

export const BLOCK_RESERVATION_KEY_PREFIX = 'hk:block_res';

const ACTIVE_STATUSES = new Set(['pending', 'confirmed']);

function keyUniq(contactId, dateStr) {
  return `${BLOCK_RESERVATION_KEY_PREFIX}:uniq:${contactId}:${dateStr}`;
}

function keyData(id) {
  return `${BLOCK_RESERVATION_KEY_PREFIX}:data:${id}`;
}

function keyDay(dateStr) {
  return `${BLOCK_RESERVATION_KEY_PREFIX}:day:${dateStr}`;
}

let _redis = undefined;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) _redis = new Redis({ url, token });
  return _redis;
}

export function isBlockReservationStoreConfigured() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return Boolean(url && token);
}

function validateDateStr(dateStr) {
  const s = String(dateStr ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function validateBlock(block) {
  return block === 'morning' || block === 'afternoon' ? block : null;
}

function parseReservationRow(raw) {
  if (raw == null) return null;
  try {
    const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!row || typeof row !== 'object') return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * @param {BlockReservation} r
 * @returns {object}
 */
export function reservationToSyntheticCalendarEvent(r) {
  const w = normalizeWorkType(r?.workType);
  const durMin = plannedMinutesForType(w);
  const block = validateBlock(r?.block);
  const dateStr = validateDateStr(r?.dateStr);
  const hour = block === 'morning' ? 10 : 14;
  const start = dateStr ? amsterdamWallTimeToDate(dateStr, hour, 0) : null;
  const startMs = start ? start.getTime() : Date.now();
  const isPending = r?.status === 'pending';
  return {
    startTime: startMs,
    endTime: startMs + durMin * 60 * 1000,
    title: `__hk_block_res__ ${w}`,
    contactId: String(r?.contactId ?? '').trim(),
    _hkSyntheticBlock: block,
    _hkReservationStatus: r?.status || 'confirmed',
    _hkPendingBooking: isPending,
  };
}

function reservationsToSyntheticEvents(reservations, statusFilter) {
  if (!Array.isArray(reservations) || reservations.length === 0) return [];
  const allowed = statusFilter instanceof Set ? statusFilter : new Set([statusFilter]);
  return reservations
    .filter(
      (row) =>
        row &&
        allowed.has(row.status) &&
        validateDateStr(row.dateStr) &&
        validateBlock(row.block) &&
        String(row.contactId ?? '').trim()
    )
    .map((row) => reservationToSyntheticCalendarEvent(row));
}

export function confirmedReservationsToSyntheticEvents(reservations) {
  return reservationsToSyntheticEvents(reservations, new Set(['confirmed']));
}

export function pendingReservationsToSyntheticEvents(reservations) {
  return reservationsToSyntheticEvents(reservations, new Set(['pending']));
}

export function activeReservationsToSyntheticEvents(reservations) {
  return reservationsToSyntheticEvents(reservations, ACTIVE_STATUSES);
}

/**
 * @param {string} dateStr
 * @param {Set<BlockReservationStatus>|BlockReservationStatus[]} [statusFilter]
 */
async function listReservationsForDate(dateStr, statusFilter = ACTIVE_STATUSES) {
  const redis = getRedis();
  if (!redis) return [];

  const ds = validateDateStr(dateStr);
  if (!ds) return [];

  const allowed =
    statusFilter instanceof Set
      ? statusFilter
      : new Set(Array.isArray(statusFilter) ? statusFilter : [statusFilter]);

  const ids = await redis.smembers(keyDay(ds));
  if (!Array.isArray(ids) || ids.length === 0) return [];

  /** @type {BlockReservation[]} */
  const out = [];
  for (const rawId of ids) {
    const id = String(rawId ?? '').trim();
    if (!id) continue;
    const row = parseReservationRow(await redis.get(keyData(id)));
    if (row && allowed.has(row.status)) {
      out.push(row);
    }
  }
  return out;
}

export async function listConfirmedForDate(dateStr) {
  return listReservationsForDate(dateStr, new Set(['confirmed']));
}

export async function listPendingForDate(dateStr) {
  return listReservationsForDate(dateStr, new Set(['pending']));
}

export async function listActiveForDate(dateStr) {
  return listReservationsForDate(dateStr, ACTIVE_STATUSES);
}

export async function listConfirmedSyntheticEventsForDate(dateStr) {
  const rows = await listConfirmedForDate(dateStr);
  return confirmedReservationsToSyntheticEvents(rows);
}

export async function listPendingSyntheticEventsForDate(dateStr) {
  const rows = await listPendingForDate(dateStr);
  return pendingReservationsToSyntheticEvents(rows);
}

/** pending + confirmed — voor capaciteit / invite-validatie */
export async function listActiveSyntheticEventsForDate(dateStr) {
  const rows = await listActiveForDate(dateStr);
  return activeReservationsToSyntheticEvents(rows);
}

/**
 * @param {string} contactId
 * @param {string} dateStr
 * @returns {Promise<BlockReservation|null>}
 */
export async function getReservationByContactDate(contactId, dateStr) {
  const redis = getRedis();
  if (!redis) return null;

  const cid = String(contactId ?? '').trim();
  const ds = validateDateStr(dateStr);
  if (!cid || !ds) return null;

  const idRaw = await redis.get(keyUniq(cid, ds));
  if (idRaw == null || !String(idRaw).trim()) return null;
  return parseReservationRow(await redis.get(keyData(String(idRaw).trim())));
}

async function writeReservation(reservation, { overwriteUniq = true } = {}) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'STORE_UNAVAILABLE' };

  const id = String(reservation?.id ?? '').trim();
  const cid = String(reservation?.contactId ?? '').trim();
  const ds = validateDateStr(reservation?.dateStr);
  if (!id || !cid || !ds) return { ok: false, code: 'BAD_INPUT' };

  const uKey = keyUniq(cid, ds);
  if (overwriteUniq) {
    await redis.set(uKey, id);
  } else {
    const nx = await redis.set(uKey, id, { nx: true });
    if (nx == null) return { ok: false, code: 'DUPLICATE_CONTACT_DATE' };
  }

  await redis.set(keyData(id), JSON.stringify(reservation));
  await redis.sadd(keyDay(ds), id);
  return { ok: true, reservation };
}

export async function removeReservationById(reservation) {
  const redis = getRedis();
  if (!redis || !reservation) return;

  const id = String(reservation.id ?? '').trim();
  const cid = String(reservation.contactId ?? '').trim();
  const ds = validateDateStr(reservation.dateStr);
  if (!id) return;

  await redis.del(keyData(id));
  if (cid && ds) {
    const uKey = keyUniq(cid, ds);
    const cur = await redis.get(uKey);
    if (String(cur) === id) await redis.del(uKey);
    await redis.srem(keyDay(ds), id);
  }
}

/**
 * @param {{ contactId: string, dateStr: string, block: 'morning'|'afternoon', workType?: string, locationId?: string, metadata?: Record<string, unknown> }} input
 */
export async function createPendingReservation(input) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'STORE_UNAVAILABLE' };

  const contactId = String(input?.contactId ?? '').trim();
  const dateStr = validateDateStr(input?.dateStr);
  const block = validateBlock(input?.block);
  if (!contactId || !dateStr || !block) {
    return { ok: false, code: 'BAD_INPUT' };
  }

  const workType = normalizeWorkType(input?.workType);
  const locationId = String(input?.locationId ?? '').trim() || '';
  const metadata =
    input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};

  const existing = await getReservationByContactDate(contactId, dateStr);
  if (existing?.status === 'confirmed') {
    return { ok: false, code: 'ALREADY_CONFIRMED', reservation: existing };
  }

  let overwritten = false;
  if (existing?.status === 'pending') {
    await removeReservationById(existing);
    overwritten = true;
  }

  const id = randomUUID();
  const now = Date.now();
  /** @type {BlockReservation} */
  const reservation = {
    id,
    contactId,
    dateStr,
    block,
    workType,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...(locationId ? { locationId } : {}),
    metadata,
  };

  const written = await writeReservation(reservation, { overwriteUniq: true });
  if (!written.ok) return written;
  return { ok: true, reservation, overwritten };
}

/**
 * @param {{ reservationId?: string, contactId?: string, dateStr?: string, block?: 'morning'|'afternoon', workType?: string }} input
 */
export async function confirmPendingReservation(input) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'STORE_UNAVAILABLE' };

  let reservation = null;
  const reservationId = String(input?.reservationId ?? '').trim();
  if (reservationId) {
    reservation = parseReservationRow(await redis.get(keyData(reservationId)));
  } else {
    const contactId = String(input?.contactId ?? '').trim();
    const dateStr = validateDateStr(input?.dateStr);
    if (contactId && dateStr) {
      reservation = await getReservationByContactDate(contactId, dateStr);
    }
  }

  if (!reservation) return { ok: false, code: 'NOT_FOUND' };
  if (reservation.status === 'confirmed') {
    return { ok: false, code: 'ALREADY_CONFIRMED', reservation };
  }
  if (reservation.status !== 'pending') {
    return { ok: false, code: 'NOT_PENDING', reservation };
  }

  const block = validateBlock(input?.block) || validateBlock(reservation.block);
  const dateStr = validateDateStr(input?.dateStr) || validateDateStr(reservation.dateStr);
  if (!block || !dateStr) return { ok: false, code: 'BAD_INPUT' };

  const workType = normalizeWorkType(input?.workType || reservation.workType);
  const now = Date.now();

  if (dateStr !== reservation.dateStr) {
    await removeReservationById(reservation);
    /** @type {BlockReservation} */
    const moved = {
      ...reservation,
      dateStr,
      block,
      workType,
      status: 'confirmed',
      confirmedAt: now,
      updatedAt: now,
    };
    const written = await writeReservation(moved, { overwriteUniq: true });
    if (!written.ok) return written;
    return { ok: true, reservation: moved, upgraded: true };
  }

  /** @type {BlockReservation} */
  const updated = {
    ...reservation,
    dateStr,
    block,
    workType,
    status: 'confirmed',
    confirmedAt: now,
    updatedAt: now,
  };

  await redis.set(keyData(reservation.id), JSON.stringify(updated));
  return { ok: true, reservation: updated, upgraded: true };
}

export async function createConfirmedReservation(input) {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }

  const contactId = String(input?.contactId ?? '').trim();
  const dateStr = validateDateStr(input?.dateStr);
  const block = validateBlock(input?.block);
  if (!contactId || !dateStr || !block) {
    return { ok: false, code: 'BAD_INPUT' };
  }

  const existing = await getReservationByContactDate(contactId, dateStr);
  if (existing?.status === 'pending') {
    return confirmPendingReservation({
      contactId,
      dateStr,
      block,
      workType: input?.workType,
    });
  }
  if (existing?.status === 'confirmed') {
    return { ok: false, code: 'DUPLICATE_CONTACT_DATE', reservation: existing };
  }

  const workType = normalizeWorkType(input?.workType);
  const id = randomUUID();
  const now = Date.now();
  /** @type {BlockReservation} */
  const reservation = {
    id,
    contactId,
    dateStr,
    block,
    workType,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
    confirmedAt: now,
  };

  return writeReservation(reservation, { overwriteUniq: false });
}

export async function hasConfirmedForContactDate(contactId, dateStr) {
  const row = await getReservationByContactDate(contactId, dateStr);
  return row?.status === 'confirmed';
}

export async function hasPendingForContactDate(contactId, dateStr) {
  const row = await getReservationByContactDate(contactId, dateStr);
  return row?.status === 'pending';
}

export async function rollbackConfirmedReservation(row) {
  const redis = getRedis();
  if (!redis) return false;

  const id = String(row?.id ?? '').trim();
  const cid = String(row?.contactId ?? '').trim();
  const ds = validateDateStr(row?.dateStr);
  if (!id || !cid || !ds) return false;

  const uKey = keyUniq(cid, ds);
  const cur = await redis.get(uKey);
  if (String(cur) !== id) return false;

  await redis.del(keyData(id));
  await redis.del(uKey);
  await redis.srem(keyDay(ds), id);
  return true;
}

export async function deleteConfirmedReservationForContactDate(contactId, dateStr) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'NO_REDIS' };

  const cid = String(contactId ?? '').trim();
  const ds = validateDateStr(dateStr);
  if (!cid || !ds) return { ok: false, code: 'BAD_INPUT' };

  const existing = await getReservationByContactDate(cid, ds);
  if (!existing) {
    return { ok: true, code: 'NO_RESERVATION', reservationId: null };
  }

  await removeReservationById(existing);
  return { ok: true, code: 'DELETED', reservationId: existing.id };
}

/**
 * Alle pending reserveringen (scan data-keys). Voor admin cleanup.
 * @returns {Promise<BlockReservation[]>}
 */
export async function listAllPendingReservations() {
  const redis = getRedis();
  if (!redis) return [];

  const pattern = `${BLOCK_RESERVATION_KEY_PREFIX}:data:*`;
  /** @type {BlockReservation[]} */
  const out = [];
  let cursor = 0;

  try {
    do {
      let scanOut;
      try {
        scanOut = await redis.scan(cursor, { match: pattern, count: 100 });
      } catch {
        scanOut = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      }
      const [nextCursorRaw, keysRaw] = Array.isArray(scanOut) ? scanOut : [0, []];
      const nextCursor = Number(nextCursorRaw) || 0;
      const keys = Array.isArray(keysRaw) ? keysRaw : [];

      for (const keyRaw of keys) {
        const key = String(keyRaw || '').trim();
        if (!key) continue;
        const id = key.slice(`${BLOCK_RESERVATION_KEY_PREFIX}:data:`.length);
        if (!id) continue;
        const row = parseReservationRow(await redis.get(keyData(id)));
        if (row?.status === 'pending') out.push(row);
      }

      cursor = nextCursor;
    } while (cursor !== 0);
  } catch (err) {
    console.error('[listAllPendingReservations] error:', err?.message || err);
    return [];
  }

  return out;
}

export async function listReservationsForContact(contactId) {
  const cid = String(contactId ?? '').trim();
  if (!cid) return [];
  const redis = getRedis();
  if (!redis) return [];

  try {
    const pattern = `${BLOCK_RESERVATION_KEY_PREFIX}:uniq:${cid}:*`;
    const results = [];
    let cursor = 0;

    do {
      let scanOut;
      try {
        scanOut = await redis.scan(cursor, { match: pattern, count: 100 });
      } catch {
        scanOut = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      }
      const [nextCursorRaw, keysRaw] = Array.isArray(scanOut) ? scanOut : [0, []];
      const nextCursor = Number(nextCursorRaw) || 0;
      const keys = Array.isArray(keysRaw) ? keysRaw : [];

      for (const keyRaw of keys) {
        const key = String(keyRaw || '').trim();
        if (!key) continue;
        const parts = key.split(':');
        const dateStr = parts[parts.length - 1] || '';
        const reservationIdRaw = await redis.get(key);
        const reservationId = String(reservationIdRaw ?? '').trim();
        if (!reservationId) continue;

        const row = parseReservationRow(await redis.get(keyData(reservationId)));
        if (!row) continue;
        results.push({
          contactId: cid,
          dateStr,
          block: row?.block || null,
          workType: row?.workType || null,
          status: row?.status || null,
          id: reservationId,
        });
      }

      cursor = nextCursor;
    } while (cursor !== 0);

    return results;
  } catch (err) {
    console.error('[listReservationsForContact] error:', err);
    return [];
  }
}
