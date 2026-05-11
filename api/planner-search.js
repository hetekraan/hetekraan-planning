/**
 * GET /api/planner-search?q=
 * Auth (X-HK-Auth), rate limit `planner_search`, max resultaten via lib — ongewijzigd.
 * Zoeklogica: zie `lib/planner-appointment-search-ghl.js` (GHL+Redis **en** optioneel Supabase mirror).
 */
import { applySecurityHeaders, enforceSimpleRateLimit } from '../lib/http-security.js';
import { getOrCreateRequestId, logEvent } from '../lib/observability.js';
import { verifySessionToken } from '../lib/session.js';
import {
  getPlannerSearchBackendEnv,
  plannerSearchMeta,
  searchPlannerAppointmentsGhl,
} from '../lib/planner-appointment-search-ghl.js';

function requireAuth(req, res) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  const token = req.headers['x-hk-auth'];
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: 'Niet ingelogd of sessie verlopen' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  applySecurityHeaders(res);
  const requestId = getOrCreateRequestId(req, res);
  if (!enforceSimpleRateLimit(req, res, 'planner_search')) {
    logEvent('rate_limit_exceeded', { route: 'api/planner-search', request_id: requestId }, 'warn');
    return res.status(429).json({ error: 'Te veel requests, probeer zo opnieuw.' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAuth(req, res)) return;

  const qRaw = String(req.query?.q || '').trim();
  const envFlags = getPlannerSearchBackendEnv();
  logEvent('api_planner_search', {
    q_len: qRaw.length,
    request_id: requestId,
    supabase_enabled: envFlags.hasSb,
    ghl_enabled: envFlags.hasGhl,
  });
  if (qRaw.length < 2) {
    return res.status(200).json({
      results: [],
      meta: plannerSearchMeta({ ...envFlags, totalResults: 0 }),
    });
  }

  if (!envFlags.hasSb) {
    logEvent(
      'planner_search_supabase_unconfigured',
      {
        request_id: requestId,
        has_supabase_url: !!String(process.env.SUPABASE_URL || '').trim(),
        has_supabase_service_role_key: !!String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
      },
      'warn'
    );
  }

  const { results, error, meta } = await searchPlannerAppointmentsGhl(qRaw, {
    limitContacts: 25,
    maxResults: 50,
  });
  if (error) {
    return res.status(503).json({ error, results: [], meta: meta || plannerSearchMeta({ ...envFlags, totalResults: 0 }) });
  }
  return res.status(200).json({ results, meta });
}
