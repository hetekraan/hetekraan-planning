/**
 * /api/snapshot?snapshot_id=<id>
 *
 * Muteert één rij in Supabase `appointment_snapshots` (Klanten-pagina):
 *  - PATCH  → werk alleen tekstvelden bij: `appointment_desc` + `type`
 *             (kolom én `payload`-mirror in sync). Financiële velden blijven vergrendeld.
 *  - DELETE → verwijder de snapshot-rij op `snapshot_id`.
 *
 * Auth: verifySessionToken (zelfde patroon als customer-detail).
 * Supabase: service-role key (RLS bypass), net als writeAppointmentSnapshot.
 */
import { verifySessionToken } from '../lib/session.js';
import { fetchWithRetry } from '../lib/retry.js';

function ensureAuth(req) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

function supabaseEnv() {
  const url = stripUrl(String(process.env.SUPABASE_URL || '').trim());
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { url, key, ok: !!(url && key) };
}

function sbHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
    ...extra,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ensureAuth(req)) return res.status(401).json({ ok: false, error: 'Niet geautoriseerd' });

  const snapshotId = String(req.query?.snapshot_id || req.query?.snapshotId || '').trim();
  if (!snapshotId) return res.status(400).json({ ok: false, error: 'snapshot_id vereist' });

  const { url, key, ok: hasSb } = supabaseEnv();
  if (!hasSb) return res.status(503).json({ ok: false, error: 'Supabase niet geconfigureerd' });

  const idQuery = `snapshot_id=eq.${encodeURIComponent(snapshotId)}`;
  const rowUrl = `${url}/rest/v1/appointment_snapshots?${idQuery}`;

  try {
    if (req.method === 'DELETE') {
      const del = await fetchWithRetry(rowUrl, {
        method: 'DELETE',
        headers: sbHeaders(key, { Prefer: 'return=representation' }),
      });
      if (!del.ok) {
        const detail = (await del.text().catch(() => '')).slice(0, 300);
        return res.status(502).json({ ok: false, error: 'Snapshot verwijderen mislukt', detail });
      }
      const rows = await del.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Snapshot niet gevonden' });
      }
      return res.status(200).json({ ok: true, deleted: snapshotId });
    }

    if (req.method === 'PATCH') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const hasDesc = Object.prototype.hasOwnProperty.call(body, 'appointment_desc');
      const hasType = Object.prototype.hasOwnProperty.call(body, 'type');
      if (!hasDesc && !hasType) {
        return res.status(400).json({ ok: false, error: 'Geen velden om bij te werken (appointment_desc/type)' });
      }
      const desc = hasDesc ? String(body.appointment_desc ?? '').trim() : undefined;
      const type = hasType ? String(body.type ?? '').trim().toLowerCase() : undefined;

      // Bestaande payload lezen om de jsonb-mirror in sync te houden.
      const getRes = await fetchWithRetry(`${rowUrl}&select=payload`, {
        method: 'GET',
        headers: sbHeaders(key),
      });
      if (!getRes.ok) {
        const detail = (await getRes.text().catch(() => '')).slice(0, 300);
        return res.status(502).json({ ok: false, error: 'Snapshot lezen mislukt', detail });
      }
      const existing = await getRes.json().catch(() => []);
      if (!Array.isArray(existing) || existing.length === 0) {
        return res.status(404).json({ ok: false, error: 'Snapshot niet gevonden' });
      }
      const payload =
        existing[0]?.payload && typeof existing[0].payload === 'object' ? { ...existing[0].payload } : {};

      const update = {};
      if (hasDesc) {
        update.appointment_desc = desc;
        payload.appointment_desc = desc;
      }
      if (hasType) {
        update.type = type;
        payload.type = type;
      }
      update.payload = payload;

      const patch = await fetchWithRetry(rowUrl, {
        method: 'PATCH',
        headers: sbHeaders(key, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(update),
      });
      if (!patch.ok) {
        const detail = (await patch.text().catch(() => '')).slice(0, 300);
        return res.status(502).json({ ok: false, error: 'Snapshot bijwerken mislukt', detail });
      }
      const rows = await patch.json().catch(() => []);
      return res.status(200).json({
        ok: true,
        snapshot_id: snapshotId,
        appointment_desc: hasDesc ? desc : undefined,
        type: hasType ? type : undefined,
        row: Array.isArray(rows) ? rows[0] : rows,
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Snapshot-bewerking mislukt', detail: String(err?.message || err) });
  }
}
