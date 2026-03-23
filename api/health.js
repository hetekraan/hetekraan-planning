// Health check endpoint: GET /api/health
// Controleert of GHL en OpenRouter bereikbaar zijn.
// Kan worden gemonitord door bijv. UptimeRobot (gratis).

import { fetchWithRetry } from '../lib/retry.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const OPENROUTER_KEY  = process.env.OPENROUTER_API_KEY;

export default async function handler(req, res) {
  const checks = {};
  const start = Date.now();

  // Check 1: GHL API
  try {
    const r = await fetchWithRetry(
      `https://services.leadconnectorhq.com/conversations/search?locationId=${GHL_LOCATION_ID}&limit=1`,
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' } },
      1
    );
    checks.ghl = r.ok ? 'ok' : `error (${r.status})`;
  } catch (e) {
    checks.ghl = `error: ${e.message}`;
  }

  // Check 2: OpenRouter
  try {
    const r = await fetchWithRetry(
      'https://openrouter.ai/api/v1/models',
      { headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}` } },
      1
    );
    checks.openrouter = r.ok ? 'ok' : `error (${r.status})`;
  } catch (e) {
    checks.openrouter = `error: ${e.message}`;
  }

  const allOk = Object.values(checks).every(v => v === 'ok');
  const statusCode = allOk ? 200 : 503;

  return res.status(statusCode).json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    uptime_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'local',
  });
}
