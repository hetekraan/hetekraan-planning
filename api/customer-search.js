/**
 * GET /api/customer-search?q=<query>
 *
 * Gerichte klant-zoek (geen bulk-scan): GHL contact-search + Moneybird-search,
 * gemerged op email/telefoon, verrijkt met "laatste afspraak" via één bulk
 * Supabase-query op appointment_snapshots (legacy GHL-veld als fallback).
 */
import { verifySessionToken } from '../lib/session.js';
import { ghlLocationIdFromEnv, GHL_CONFIG_MISSING_MSG } from '../lib/ghl-env-ids.js';
import {
  getCustomerDirectoryEnv,
  searchGhlContacts,
  searchMoneybirdContacts,
  mergeDirectoryContacts,
  fetchLatestSnapshotByContact,
  readLegacyLastAppointment,
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

  const q = String(req.query?.q || '').trim();
  if (q.length < 2) {
    return res.status(200).json({ ok: true, results: [], meta: { ghl: 0, moneybird: 0, merged: 0 } });
  }

  const { locationId, hasGhl } = getCustomerDirectoryEnv();
  if (!hasGhl) {
    return res.status(503).json({ ok: false, error: GHL_CONFIG_MISSING_MSG });
  }

  try {
    const [ghlCards, mbCards] = await Promise.all([
      searchGhlContacts(q, { locationId: locationId || ghlLocationIdFromEnv(), limit: 25 }),
      searchMoneybirdContacts(q),
    ]);

    const merged = mergeDirectoryContacts(ghlCards, mbCards);

    const contactIds = merged.map((m) => m.contactId).filter(Boolean);
    const latestByContact = await fetchLatestSnapshotByContact(contactIds);

    const results = merged.map((m) => {
      let lastAppointment = null;
      const snap = m.contactId ? latestByContact.get(m.contactId) : null;
      if (snap && snap.date) {
        lastAppointment = { date: snap.date, type: snap.type, source: 'snapshot' };
      } else if (m._contact) {
        const legacy = readLegacyLastAppointment(m._contact);
        if (legacy && legacy.date) {
          lastAppointment = { date: legacy.date, type: legacy.type, source: 'legacy' };
        }
      }
      return {
        contactId: m.contactId || null,
        name: m.name,
        address: m.address || '',
        phone: m.phone || '',
        email: m.email || '',
        hasMoneybird: m.hasMoneybird === true,
        lastAppointment,
      };
    });

    return res.status(200).json({
      ok: true,
      results,
      meta: { ghl: ghlCards.length, moneybird: mbCards.length, merged: results.length },
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Klant-zoeken mislukt', detail: String(err?.message || err) });
  }
}
