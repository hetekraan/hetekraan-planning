/**
 * POST /api/admin/cleanup-orphan-pendings
 * Verwijdert pending Redis-holds van 2-slot invites (boekingsvoorstel_optie_2 ingevuld).
 *
 * Auth: Authorization: Bearer <CLEANUP_SECRET> (of CRON_SECRET als fallback)
 * Body (optioneel): { "dryRun": true }
 */

import { cleanupOrphanPendingReservations } from '../../lib/cleanup-orphan-pendings.js';

function authorize(req) {
  const secret =
    String(process.env.CLEANUP_SECRET || '').trim() ||
    String(process.env.CRON_SECRET || '').trim();
  if (!secret) return true;
  const authHeader = String(req.headers?.authorization || '').trim();
  return authHeader === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authorize(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = String(process.env.GHL_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'GHL_API_KEY ontbreekt' });
  }

  let dryRun = false;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (body && body.dryRun === true) dryRun = true;
  } catch {
    /* ignore */
  }

  const out = await cleanupOrphanPendingReservations({
    apiKey,
    dryRun,
  });

  if (!out.ok) {
    return res.status(503).json(out);
  }

  return res.status(200).json({
    success: true,
    dryRun: out.dryRun,
    scanned: out.scanned,
    removedCount: out.removedCount,
    removed: out.removed,
    skipped: out.skipped,
    errors: out.errors,
  });
}
