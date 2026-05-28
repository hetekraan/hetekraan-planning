import { verifySessionToken } from '../lib/session.js';
import { ghlCalendarIdFromEnv, ghlLocationIdFromEnv, GHL_CONFIG_MISSING_MSG } from '../lib/ghl-env-ids.js';
import { buildBuslijstWeek, normalizeWeekStart } from '../lib/buslijst-build.js';
import { listPrices } from '../lib/prices-store.js';
import { loadPlannerAppointmentsForDate } from './ghl.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!ensureAuth(req)) return res.status(401).json({ error: 'Niet geautoriseerd' });

  const GHL_API_KEY = process.env.GHL_API_KEY?.trim();
  const loc = locationId();
  const cal = ghlCalendarIdFromEnv();
  if (!GHL_API_KEY || !ghlLocationIdFromEnv() || !cal) {
    return res.status(503).json({ error: GHL_CONFIG_MISSING_MSG });
  }

  const startRaw = String(req.query?.startDate || req.query?.weekStart || '').trim();
  const weekStart = normalizeWeekStart(startRaw);

  try {
    const body = await buildBuslijstWeek({
      weekStart,
      listPrices: () => listPrices(loc),
      loadAppointmentsForDate: (dateYmd) => loadPlannerAppointmentsForDate(dateYmd),
    });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json(body);
  } catch (err) {
    console.error('[buslijst] build_failed', { weekStart, message: err?.message || String(err) });
    return res.status(500).json({ error: 'Kon buslijst niet opbouwen' });
  }
}
