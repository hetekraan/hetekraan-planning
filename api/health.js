// Health check endpoint: GET /api/health
// Controleert of GHL en OpenRouter bereikbaar zijn.
// Kan worden gemonitord door bijv. UptimeRobot (gratis).
//
// POST /api/health + header x-booking-debug-secret + JSON { "contactId": "…" }
// = WhatsApp/GHL API-diagnose (Hobby-plan: geen apart endpoint om functielimiet te sparen).

import { fetchWithRetry } from '../lib/retry.js';
import { runWhatsappDebugTest } from '../lib/ghl-whatsapp-debug-test.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const OPENROUTER_KEY  = process.env.OPENROUTER_API_KEY;

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b && typeof b === 'object' ? b : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST') {
    const secret = process.env.BOOKING_DEBUG_SECRET;
    const provided = req.headers['x-booking-debug-secret'];
    if (!secret) {
      return res.status(503).json({
        error:
          'BOOKING_DEBUG_SECRET ontbreekt in Vercel. Zet die variable, of gebruik GET voor een normale health check.',
      });
    }
    if (!provided || provided !== secret) {
      return res.status(401).json({
        error: 'Voor WhatsApp-test: header x-booking-debug-secret moet gelijk zijn aan BOOKING_DEBUG_SECRET.',
      });
    }
    const body = parseBody(req);
    if (!body) return res.status(400).json({ error: 'JSON body verplicht, bv. {"contactId":"…"}' });
    const out = await runWhatsappDebugTest(body.contactId);
    if (out._httpStatus) {
      const { _httpStatus, ...rest } = out;
      return res.status(_httpStatus).json(rest);
    }
    return res.status(200).json({ ...out, via: '/api/health POST' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Gebruik GET voor health, of POST voor WhatsApp-debug (met secret).' });
  }

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
