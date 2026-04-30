import { Redis } from '@upstash/redis';
import { verifySessionToken } from '../lib/session.js';
import { getMoneybirdCashflowByMonth } from '../lib/moneybird-cashflow.js';

const CACHE_KEY = 'hk:cashflow:v1';
const CACHE_TTL_SECONDS = 60 * 60;

let _redis = undefined;

function ensureAuth(req) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) _redis = new Redis({ url, token });
  return _redis;
}

async function readCache() {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(CACHE_KEY);
  if (!raw) return null;
  if (typeof raw === 'object' && raw?.items) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL_SECONDS });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ensureAuth(req)) return res.status(401).json({ error: 'Niet geautoriseerd' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const items = await getMoneybirdCashflowByMonth();
    const payload = { items, cachedAt: new Date().toISOString() };
    await writeCache(payload);
    return res.status(200).json({ ok: true, ...payload, source: 'moneybird' });
  } catch (err) {
    const cached = await readCache();
    if (cached?.items) {
      return res.status(200).json({
        ok: true,
        items: cached.items,
        cachedAt: cached.cachedAt || null,
        source: 'cache_fallback',
        warning: String(err?.message || err),
      });
    }
    return res.status(502).json({ ok: false, error: 'Cashflow ophalen mislukt', detail: String(err?.message || err) });
  }
}
