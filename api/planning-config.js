// Publieke (niet-gevoelige) config voor het dashboard: alleen location-id voor GHL-contactlinks.
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ghlLocationId = ghlLocationIdFromEnv() || null;
  return res.status(200).json({
    ghlLocationId,
    /** Zonder location-id zijn contactlinks in het dashboard niet te bouwen. */
    ghlLinksOk: Boolean(ghlLocationId),
  });
}
