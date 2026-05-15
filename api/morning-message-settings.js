import { verifySessionToken } from '../lib/session.js';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import {
  getMorningMessageSettings,
  setMorningMessageEnabled,
} from '../lib/morning-message-store.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  res.setHeader('Cache-Control', 'no-store');
}

function isAuthed(req) {
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

function normalizeDateStr(raw) {
  const s = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const locationId = String(req.query?.locationId || req.body?.locationId || ghlLocationIdFromEnv() || '').trim();
  const dateStr = normalizeDateStr(req.query?.date || req.query?.dateStr || req.body?.dateStr || req.body?.date);
  if (!locationId || !dateStr) {
    return res.status(400).json({ error: 'locationId en date (YYYY-MM-DD) vereist' });
  }

  if (req.method === 'GET') {
    const out = await getMorningMessageSettings(locationId, dateStr);
    if (!out.ok) {
      return res.status(500).json({ error: out.code || 'READ_FAILED', settings: out.settings });
    }
    return res.status(200).json({ ok: true, settings: out.settings });
  }

  if (req.method === 'POST') {
    const enabled = req.body?.enabled !== false;
    const updatedBy = String(req.body?.updatedBy || 'planner').trim() || 'planner';
    const out = await setMorningMessageEnabled(locationId, dateStr, enabled, updatedBy);
    if (!out.ok) {
      return res.status(500).json({ error: out.code || 'WRITE_FAILED' });
    }
    return res.status(200).json({ ok: true, settings: out.settings });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
