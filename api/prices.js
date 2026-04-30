import { verifySessionToken } from '../lib/session.js';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import { deletePrice, isPricesStoreConfigured, listPrices, upsertPrice } from '../lib/prices-store.js';
import { Redis } from '@upstash/redis';

const PRICES_LAST_UPDATED_KEY = 'hk:prices:last_updated';
let _redis = undefined;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) _redis = new Redis({ url, token });
  return _redis;
}

async function getPricesLastUpdated() {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(PRICES_LAST_UPDATED_KEY);
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

async function touchPricesLastUpdated() {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(PRICES_LAST_UPDATED_KEY, String(Date.now()));
}

function ensureAuth(req) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

function locationId() {
  return ghlLocationIdFromEnv() || process.env.GHL_LOCATION_ID || 'default';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isPricesStoreConfigured()) return res.status(500).json({ error: 'Prices store niet geconfigureerd' });
  if (!ensureAuth(req)) return res.status(401).json({ error: 'Niet geautoriseerd' });

  const loc = locationId();
  if (req.method === 'GET') {
    if (String(req.query?.meta || '') === '1') {
      const lastUpdated = await getPricesLastUpdated();
      return res.status(200).json({ ok: true, lastUpdated });
    }
    const rows = await listPrices(loc);
    const lastUpdated = await getPricesLastUpdated();
    return res.status(200).json({ ok: true, items: rows, lastUpdated });
  }
  if (req.method === 'POST' || req.method === 'PATCH') {
    const out = await upsertPrice(loc, req.body || {});
    if (!out.ok) return res.status(400).json({ ok: false, code: out.code });
    await touchPricesLastUpdated();
    return res.status(200).json({ ok: true, item: out.row });
  }
  if (req.method === 'DELETE') {
    const out = await deletePrice(loc, req.query?.id || req.body?.id);
    if (!out.ok) return res.status(400).json({ ok: false, code: out.code });
    await touchPricesLastUpdated();
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
