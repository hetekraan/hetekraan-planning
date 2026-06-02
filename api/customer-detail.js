/**
 * GET /api/customer-detail?contactId=<id>
 *
 * Combineert vier bronnen tot één chronologische klant-tijdlijn:
 *  a) GHL contact (contact-info)
 *  b) Supabase appointment_snapshots (echte historie, source='snapshot')
 *  c) Legacy GHL custom fields (source='legacy', alleen als datum niet al in snapshots)
 *  d) Redis Model B reserveringen (source='planned', toekomstig)
 */
import { verifySessionToken } from '../lib/session.js';
import { GHL_CONFIG_MISSING_MSG } from '../lib/ghl-env-ids.js';
import { formatYyyyMmDdInAmsterdam } from '../lib/amsterdam-calendar-day.js';
import {
  getCustomerDirectoryEnv,
  getGhlContact,
  fetchSnapshotsForContact,
  readLegacyLastAppointment,
  getPlannedAppointments,
  buildContactInfo,
} from '../lib/customer-directory.js';

function ensureAuth(req) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ensureAuth(req)) return res.status(401).json({ error: 'Niet geautoriseerd' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const contactId = String(req.query?.contactId || '').trim();
  if (!contactId) return res.status(400).json({ ok: false, error: 'contactId vereist' });

  const { hasGhl } = getCustomerDirectoryEnv();
  if (!hasGhl) return res.status(503).json({ ok: false, error: GHL_CONFIG_MISSING_MSG });

  try {
    const todayYmd = formatYyyyMmDdInAmsterdam(new Date()) || new Date().toISOString().split('T')[0];

    const [contact, snapshots, planned] = await Promise.all([
      getGhlContact(contactId),
      fetchSnapshotsForContact(contactId),
      getPlannedAppointments(contactId, { todayYmd }),
    ]);

    if (!contact) {
      return res.status(404).json({ ok: false, error: 'Contact niet gevonden' });
    }

    const appointments = [...snapshots];

    // Legacy fallback: alleen tonen als de GHL-CF-datum nog niet als snapshot bestaat.
    const snapshotDates = new Set(snapshots.map((a) => a.date).filter(Boolean));
    const legacy = readLegacyLastAppointment(contact);
    if (legacy && legacy.date && !snapshotDates.has(legacy.date)) {
      appointments.push({
        date: legacy.date,
        type: legacy.type,
        status: 'klaar',
        totalPrice: legacy.totalPrice ?? null,
        priceLines: legacy.priceLines || [],
        source: 'legacy',
      });
    }

    // Geplande (toekomst) toevoegen; dubbele datums met bestaande rows overslaan.
    const existingDates = new Set(appointments.map((a) => a.date).filter(Boolean));
    for (const p of planned) {
      if (p.date && existingDates.has(p.date)) continue;
      appointments.push(p);
    }

    appointments.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    return res.status(200).json({
      ok: true,
      contact: buildContactInfo(contact),
      appointments,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Klant-detail ophalen mislukt', detail: String(err?.message || err) });
  }
}
