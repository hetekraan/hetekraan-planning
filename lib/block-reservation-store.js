/**
 * Model B — bevestigde blok-boekingen in Upstash Redis (serverless-vriendelijk).
 * Gebruikt door o.a. confirm-booking (B1); suggest/invite kunnen hier later op inhaken.
 *
 * Bron van waarheid voor “wie heeft welk dagdeel gereserveerd” naast de GHL-agenda.
 */

import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { normalizeWorkType, plannedMinutesForType } from './booking-blocks.js';

/** @typedef {'confirmed'|'cancelled'} BlockReservationStatus */

/**
 * @typedef {object} BlockReservation
 * @property {string} id — UUID
 * @property {string} contactId — GHL contact id
 * @property {string} dateStr — YYYY-MM-DD (Amsterdam kalenderdag)
 * @property {'morning'|'afternoon'} block
 * @property {string} workType — genormaliseerd (installatie|onderhoud|reparatie)
 * @property {BlockReservationStatus} status
 * @property {number} createdAt — epoch ms
 */

/** Vast prefix; alle keys hieronder hangen hiermee samen. */
export const BLOCK_RESERVATION_KEY_PREFIX = 'hk:block_res';

/**
 * Uniek per contact + dag: `hk:block_res:uniq:{contactId}:{dateStr}` → reservation `id` (string).
 * Alleen gezet met SET NX — atomair; voorkomt twee bevestigingen voor dezelfde combinatie.
 */
function keyUniq(contactId, dateStr) {
  return `${BLOCK_RESERVATION_KEY_PREFIX}:uniq:${contactId}:${dateStr}`;
}

/** Volledige record JSON: `hk:block_res:data:{id}` */
function keyData(id) {
  return `${BLOCK_RESERVATION_KEY_PREFIX}:data:${id}`;
}

/** Set van alle reservation-ids op die kalenderdag: `hk:block_res:day:{dateStr}` */
function keyDay(dateStr) {
  return `${BLOCK_RESERVATION_KEY_PREFIX}:day:${dateStr}`;
}

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

/** True als env-vars gezet zijn (maakt nog geen verbinding). */
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

/**
 * Kalender-achtig object voor `evaluateBlockOffer` / `booking-blocks` (zelfde patroon als invite-synthetisch).
 * Titel bevat werktype-keyword zodat `plannedMinutesForExistingEvent` de juiste minuten pakt.
 *
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
  return {
    startTime: startMs,
    endTime: startMs + durMin * 60 * 1000,
    /** Intern keyword voor `plannedMinutesForExistingEvent`; niet tonen aan gebruikers. */
    title: `__hk_block_res__ ${w}`,
    contactId: String(r?.contactId ?? '').trim(),
    /** Voor dashboard-enrich: leesbaar bloklabel i.p.v. ruwe titel. */
    _hkSyntheticBlock: block,
  };
}

/**
 * @param {BlockReservation[]} reservations
 * @returns {object[]}
 */
export function confirmedReservationsToSyntheticEvents(reservations) {
  if (!Array.isArray(reservations) || reservations.length === 0) return [];
  return reservations
    .filter(
      (row) =>
        row &&
        row.status === 'confirmed' &&
        validateDateStr(row.dateStr) &&
        validateBlock(row.block) &&
        String(row.contactId ?? '').trim()
    )
    .map((row) => reservationToSyntheticCalendarEvent(row));
}

/** Bevestigde Redis-reserveringen op `dateStr` als synthetische events (leeg als store ontbreekt). */
export async function listConfirmedSyntheticEventsForDate(dateStr) {
  const rows = await listConfirmedForDate(dateStr);
  return confirmedReservationsToSyntheticEvents(rows);
}

/**
 * Sla één bevestigde reservering op.
 *
 * @param {{ contactId: string, dateStr: string, block: 'morning'|'afternoon', workType?: string }} input
 * @returns {Promise<
 *   | { ok: true, reservation: BlockReservation }
 *   | { ok: false, code: 'DUPLICATE_CONTACT_DATE' | 'BAD_INPUT' | 'STORE_UNAVAILABLE' }
 * >}
 */
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

  const workType = normalizeWorkType(input?.workType);
  const id = randomUUID();
  /** @type {BlockReservation} */
  const reservation = {
    id,
    contactId,
    dateStr,
    block,
    workType,
    status: 'confirmed',
    createdAt: Date.now(),
  };

  const uKey = keyUniq(contactId, dateStr);
  const dKey = keyData(id);
  const daySet = keyDay(dateStr);

  let uniqSet = false;
  try {
    const nx = await redis.set(uKey, id, { nx: true });
    /** Upstash: `null` = key bestond al (NX); `'OK'` = gezet. */
    if (nx == null) {
      return { ok: false, code: 'DUPLICATE_CONTACT_DATE' };
    }
    uniqSet = true;

    await redis.set(dKey, JSON.stringify(reservation));
    await redis.sadd(daySet, id);

    return { ok: true, reservation };
  } catch (err) {
    if (uniqSet) {
      try {
        await redis.del(dKey);
        await redis.del(uKey);
      } catch {
        /* best-effort rollback */
      }
    }
    throw err;
  }
}

/**
 * Of deze contact al een bevestigde reservering heeft op deze kalenderdag (elk blok telt als één dag-boeking).
 * @param {string} contactId
 * @param {string} dateStr
 */
export async function hasConfirmedForContactDate(contactId, dateStr) {
  const redis = getRedis();
  if (!redis) return false;

  const cid = String(contactId ?? '').trim();
  const ds = validateDateStr(dateStr);
  if (!cid || !ds) return false;

  const v = await redis.get(keyUniq(cid, ds));
  return v != null && String(v).length > 0;
}

/**
 * Alle reserveringen op `dateStr` met status `confirmed` (payload uit data-keys).
 * @param {string} dateStr
 * @returns {Promise<BlockReservation[]>}
 */
export async function listConfirmedForDate(dateStr) {
  const redis = getRedis();
  if (!redis) return [];

  const ds = validateDateStr(dateStr);
  if (!ds) return [];

  const ids = await redis.smembers(keyDay(ds));
  if (!Array.isArray(ids) || ids.length === 0) return [];

  /** @type {BlockReservation[]} */
  const out = [];
  for (const rawId of ids) {
    const id = String(rawId ?? '').trim();
    if (!id) continue;
    const raw = await redis.get(keyData(id));
    if (raw == null) continue;
    try {
      const row = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (row && row.status === 'confirmed') {
        out.push(row);
      }
    } catch {
      /* corrupt row — overslaan */
    }
  }
  return out;
}

/**
 * Rollback na mislukte GHL-contact-PUT: verwijdert data, uniq en day-index.
 * Alleen als `uniq` nog naar `id` wijst (geen concurrente overschrijving).
 * @param {{ id: string, contactId: string, dateStr: string }} row
 * @returns {Promise<boolean>}
 */
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

/**
 * Planner-delete / reset: verwijdert B1-reservering voor contact+dag (idempotent).
 * @returns {Promise<{ ok: boolean, code: 'DELETED'|'NO_RESERVATION'|'BAD_INPUT'|'NO_REDIS', reservationId?: string|null }>}
 */
export async function deleteConfirmedReservationForContactDate(contactId, dateStr) {
  const redis = getRedis();
  if (!redis) return { ok: false, code: 'NO_REDIS' };

  const cid = String(contactId ?? '').trim();
  const ds = validateDateStr(dateStr);
  if (!cid || !ds) return { ok: false, code: 'BAD_INPUT' };

  const uKey = keyUniq(cid, ds);
  const idRaw = await redis.get(uKey);
  if (idRaw == null || String(idRaw).trim() === '') {
    return { ok: true, code: 'NO_RESERVATION', reservationId: null };
  }
  const id = String(idRaw).trim();
  await redis.del(keyData(id));
  await redis.del(uKey);
  await redis.srem(keyDay(ds), id);
  return { ok: true, code: 'DELETED', reservationId: id };
}
