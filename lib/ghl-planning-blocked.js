/**
 * Optioneel: geblokkeerde planningsdagen in GHL (één contact + tekstveld).
 *
 * Vercel env:
 *   GHL_PLANNING_META_CONTACT_ID   — contact waarop het veld staat (bijv. intern "Planning"-contact)
 *   GHL_PLANNING_BLOCKED_DATES_FIELD_ID — custom field type TEXT, waarde: 2026-04-01,2026-04-02
 *
 * Zo gelden blokkades op de server (WhatsApp/suggest/book) ook als localStorage leeg is of op een ander apparaat.
 */

import { fetchWithRetry } from './retry.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

export async function fetchPlanningBlockedDateSet() {
  const contactId = process.env.GHL_PLANNING_META_CONTACT_ID;
  const fieldId = process.env.GHL_PLANNING_BLOCKED_DATES_FIELD_ID;
  const key = process.env.GHL_API_KEY;
  const set = new Set();
  if (!contactId || !fieldId || !key) return set;
  try {
    const res = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${key}`, Version: '2021-04-15' },
    });
    if (!res.ok) return set;
    const data = await res.json();
    const contact = data?.contact || data;
    const cf = contact?.customFields || [];
    const raw = cf.find((f) => f.id === fieldId)?.value || '';
    for (const part of String(raw).split(',')) {
      const d = part.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
    }
  } catch (_) {}
  return set;
}

export async function putPlanningBlockedDatesToGhl(datesArray) {
  const contactId = process.env.GHL_PLANNING_META_CONTACT_ID;
  const fieldId = process.env.GHL_PLANNING_BLOCKED_DATES_FIELD_ID;
  const key = process.env.GHL_API_KEY;
  if (!contactId || !fieldId || !key) return { ok: true, skipped: true };
  const sorted = [
    ...new Set(
      (Array.isArray(datesArray) ? datesArray : [])
        .map((d) => String(d).trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    ),
  ].sort();
  const value = sorted.join(',');
  const res = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15',
    },
    body: JSON.stringify({
      customFields: [{ id: fieldId, field_value: value }],
    }),
  });
  return { ok: res.ok, skipped: false };
}
