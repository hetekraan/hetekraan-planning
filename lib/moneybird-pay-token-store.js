/**
 * Moneybird WhatsApp CTA: korte token → echte Moneybird invoiceUrl (302 redirect).
 * Zelfde Upstash Redis patroon als block-reservation-store.
 */

import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';

const PREFIX = 'hk:mb_pay';

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

export function isMoneybirdPayTokenStoreConfigured() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return Boolean(url && token);
}

function keyToken(token) {
  return `${PREFIX}:token:${String(token || '').trim()}`;
}

function keyByInvoice(invoiceId) {
  return `${PREFIX}:by_invoice:${String(invoiceId || '').trim()}`;
}

function ttlSeconds() {
  const daysRaw = Number(process.env.MONEYBIRD_PAY_TOKEN_TTL_DAYS);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 120;
  return Math.floor(days * 24 * 60 * 60);
}

function generateToken() {
  // URL-safe token; mb_ prefix voor leesbaarheid in logs/support.
  const raw = randomBytes(18).toString('base64url');
  return `mb_${raw}`;
}

/**
 * @param {string} token
 * @returns {Promise<object|null>}
 */
export async function getMoneybirdPayTokenMapping(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(keyToken(t));
  if (raw == null) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * @param {object} mapping
 * @returns {Promise<{ token: string, reused: boolean }|null>}
 */
export async function getOrCreateMoneybirdPayTokenMapping(mapping) {
  const invoiceId = String(mapping?.invoiceId || '').trim();
  const invoiceUrl = String(mapping?.invoiceUrl || '').trim();
  if (!invoiceId || !invoiceUrl) return null;

  const redis = getRedis();
  if (!redis) return null;

  const existingTokenRaw = await redis.get(keyByInvoice(invoiceId));
  const existingToken = String(existingTokenRaw || '').trim();
  if (existingToken) {
    const existing = await getMoneybirdPayTokenMapping(existingToken);
    if (existing?.invoiceUrl === invoiceUrl) {
      return { token: existingToken, reused: true };
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = generateToken();
    const payload = {
      token,
      invoiceUrl,
      invoiceId,
      contactId: String(mapping?.contactId || '').trim(),
      appointmentId: String(mapping?.appointmentId || '').trim(),
      reference: String(mapping?.reference || '').trim(),
      createdAt: new Date().toISOString(),
    };
    const ok = await redis.set(keyToken(token), JSON.stringify(payload), { nx: true, ex: ttlSeconds() });
    if (ok) {
      await redis.set(keyByInvoice(invoiceId), token, { ex: ttlSeconds() });
      return { token, reused: false };
    }
  }
  return null;
}
