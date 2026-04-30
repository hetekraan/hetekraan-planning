import { verifySessionToken } from '../lib/session.js';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import { deletePrice, isPricesStoreConfigured, listPrices, upsertPrice } from '../lib/prices-store.js';

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
    const rows = await listPrices(loc);
    return res.status(200).json({ ok: true, items: rows });
  }
  if (req.method === 'POST' || req.method === 'PATCH') {
    const out = await upsertPrice(loc, req.body || {});
    if (!out.ok) return res.status(400).json({ ok: false, code: out.code });
    return res.status(200).json({ ok: true, item: out.row });
  }
  if (req.method === 'DELETE') {
    const out = await deletePrice(loc, req.query?.id || req.body?.id);
    if (!out.ok) return res.status(400).json({ ok: false, code: out.code });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
