import { verifySessionToken } from '../lib/session.js';
import { fetchWithRetry } from '../lib/retry.js';
import { ghlLocationIdFromEnv, GHL_CONFIG_MISSING_MSG } from '../lib/ghl-env-ids.js';
import { listContacts as listMoneybirdContacts } from '../lib/moneybird.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY;

function ensureAuth(req) {
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  return Boolean(verifySessionToken(req.headers['x-hk-auth']));
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function fullName(parts = []) {
  return parts.map((x) => String(x || '').trim()).filter(Boolean).join(' ').trim();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const t = String(v || '').trim();
    if (t) return t;
  }
  return '';
}

function ghlAddress(c) {
  return firstNonEmpty(c?.address1, fullName([c?.postalCode, c?.city]), c?.address);
}

function moneybirdAddress(c) {
  return firstNonEmpty(
    c?.address1,
    fullName([c?.zipcode, c?.city]),
    c?.delivery_address,
    c?.customer_id
  );
}

function mapGhlContact(c = {}) {
  const name = firstNonEmpty(c.name, fullName([c.firstName, c.lastName])) || 'Onbekend';
  return {
    source: 'ghl',
    sourceId: String(c.id || '').trim(),
    name,
    email: normalizeEmail(c.email),
    phone: firstNonEmpty(c.phone, c.mobile),
    address: ghlAddress(c),
    hasMoneybird: false,
    moneybirdContactId: '',
  };
}

function mapMoneybirdContact(c = {}) {
  const personName = fullName([c.firstname, c.lastname]);
  const name = firstNonEmpty(personName, c.company_name) || 'Onbekend';
  return {
    source: 'moneybird',
    sourceId: String(c.id || '').trim(),
    name,
    email: normalizeEmail(c.email),
    phone: firstNonEmpty(c.phone),
    address: moneybirdAddress(c),
    hasMoneybird: true,
    moneybirdContactId: String(c.id || '').trim(),
  };
}

async function fetchAllGhlContacts(locationId) {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100&page=${page}`;
    const res = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15',
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GHL contacts fout (${res.status}): ${txt.slice(0, 180)}`);
    }
    const data = await res.json().catch(() => ({}));
    const rows = Array.isArray(data?.contacts) ? data.contacts : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function fetchAllMoneybirdContacts() {
  if (!process.env.MONEYBIRD_API_TOKEN || !process.env.MONEYBIRD_ADMINISTRATION_ID) return [];
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const rows = await listMoneybirdContacts({ page, perPage: 100 }).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

function mergeContacts(ghlContacts, mbContacts) {
  const merged = [];
  const byEmail = new Map();

  for (const c of ghlContacts) {
    const mapped = mapGhlContact(c);
    const emailKey = normalizeEmail(mapped.email);
    if (emailKey) byEmail.set(emailKey, mapped);
    merged.push(mapped);
  }

  for (const c of mbContacts) {
    const mb = mapMoneybirdContact(c);
    const emailKey = normalizeEmail(mb.email);
    if (!emailKey) {
      merged.push(mb);
      continue;
    }
    const existing = byEmail.get(emailKey);
    if (existing) {
      existing.hasMoneybird = true;
      existing.moneybirdContactId = mb.moneybirdContactId;
      if (!existing.phone && mb.phone) existing.phone = mb.phone;
      if (!existing.address && mb.address) existing.address = mb.address;
      continue;
    }
    byEmail.set(emailKey, mb);
    merged.push(mb);
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name, 'nl-NL'));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ensureAuth(req)) return res.status(401).json({ error: 'Niet geautoriseerd' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const locationId = ghlLocationIdFromEnv();
  if (!GHL_API_KEY || !locationId) {
    return res.status(503).json({ error: GHL_CONFIG_MISSING_MSG });
  }

  try {
    const [ghlContacts, moneybirdContacts] = await Promise.all([
      fetchAllGhlContacts(locationId),
      fetchAllMoneybirdContacts(),
    ]);
    const items = mergeContacts(ghlContacts, moneybirdContacts);
    return res.status(200).json({
      ok: true,
      items,
      meta: {
        ghlContacts: ghlContacts.length,
        moneybirdContacts: moneybirdContacts.length,
        mergedContacts: items.length,
      },
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'Klanten ophalen mislukt',
      detail: String(err?.message || err),
    });
  }
}
