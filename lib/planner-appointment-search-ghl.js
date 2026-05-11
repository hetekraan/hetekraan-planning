/**
 * Server-side planner-zoeken — **twee sporen**, samengevoegd en gededuped tot `maxResults`:
 *
 * [A] **GHL-contacten** (`GET /contacts?query=`) + per contact **Redis B1** (`listReservationsForContact`).
 *     Zelfde “wie heeft er geboekt”-spoor als voorheen; **geen** volledige GHL-kalenderscan.
 *     Mist afspraken waarvan het contact **niet** in de GHL-contactzoekresultaten valt.
 *
 * [B] **Supabase mirror** (`public.appointments` + `customers`) via `planner-search-supabase-appointments.js`,
 *     zelfde dual-write dataset als o.a. `syncAppointmentToSupabase` / analytics-read.
 *     Wel: match op **afspraakvelden** (omschrijving, adres, status, tijdvenster) en op **naam/telefoon**
 *     in de mirror, ook als GHL-contactquery het contact niet teruggeeft. Alleen rijen die gesynchroniseerd
 *     zijn; mogelijke **sync-lag** t.o.v. live planner.
 *
 * **≠** `loadPlannerAppointmentsSource` / planner-feed `getAppointments`: dat is **per kalenderdag**
 * (GHL calendar events + blocked slots + Redis-synthetisch + enrich). Deze zoeker **bouwt die feed niet**
 * en scant geen willekeurige dagen in de GHL-agenda.
 */
import { addAmsterdamCalendarDays, formatYyyyMmDdInAmsterdam } from './amsterdam-calendar-day.js';
import { fetchWithRetry } from './retry.js';
import { ghlLocationIdFromEnv } from './ghl-env-ids.js';
import { listReservationsForContact } from './block-reservation-store.js';
import { readCanonicalAddressLine } from './ghl-contact-canonical.js';
import {
  isPlannerSupabaseSearchConfigured,
  searchPlannerAppointmentsSupabase,
} from './planner-search-supabase-appointments.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY;

/** Voor `/api/planner-search` meta + korte queries zonder lib-run. */
export function getPlannerSearchBackendEnv() {
  const locationId = String(ghlLocationIdFromEnv() || '').trim();
  const hasGhl = !!(GHL_API_KEY && locationId);
  const hasSb = isPlannerSupabaseSearchConfigured();
  return { hasGhl, hasSb, locationId };
}

/** `meta` payload voor planner-search responses. */
export function plannerSearchMeta({ hasGhl, hasSb, totalResults }) {
  const sources = [];
  if (hasSb) sources.push('supabase');
  if (hasGhl) sources.push('ghl_redis');
  return {
    sources,
    supabaseEnabled: hasSb,
    totalResults: Math.max(0, Number(totalResults) || 0),
  };
}

/**
 * Dedupe: voor B1/redis vs Supabase dezelfde dag+contact+slot vaker één logische afspraak.
 * @param {object[]} sbRows
 * @param {object[]} ghlRows
 * @param {number} maxResults
 */
function mergePlannerSearchResults(sbRows, ghlRows, maxResults) {
  const seen = new Set();
  const out = [];
  function keyOf(hit) {
    const cid = String(hit?.contactId || '').trim();
    const d = String(hit?.date || '').trim();
    const slot = String(hit?.timeSlot || '').trim().replace(/\s+/g, ' ');
    if (cid && d && slot) return `slot:${cid}|${d}|${slot}`;
    const id = String(hit?.id || '').trim();
    if (/^hk-b1:/i.test(id)) return `id:${id}`;
    if (id) return `id:${id}`;
    return `misc:${out.length}`;
  }
  for (const row of [...sbRows, ...ghlRows]) {
    const k = keyOf(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
    if (out.length >= maxResults) break;
  }
  return out;
}

/**
 * @param {string} qRaw
 * @param {{ limitContacts?: number, maxResults?: number, dateDaysBack?: number, dateDaysForward?: number }} [opts]
 * @returns {Promise<{ results: object[], error?: string, meta: object }>}
 */
export async function searchPlannerAppointmentsGhl(qRaw, opts = {}) {
  const qTrim = String(qRaw || '').trim();
  const q = qTrim.toLowerCase();
  const { hasGhl, hasSb, locationId } = getPlannerSearchBackendEnv();

  if (q.length < 2) {
    return { results: [], meta: plannerSearchMeta({ hasGhl, hasSb, totalResults: 0 }) };
  }

  const limitContacts = Math.min(50, Math.max(5, Number(opts.limitContacts) || 25));
  const maxResults = Math.min(80, Math.max(10, Number(opts.maxResults) || 50));
  const dateDaysBack = Number.isFinite(Number(opts.dateDaysBack)) ? Number(opts.dateDaysBack) : 540;
  const dateDaysForward = Number.isFinite(Number(opts.dateDaysForward)) ? Number(opts.dateDaysForward) : 540;

  if (!hasGhl && !hasSb) {
    return {
      results: [],
      error: 'Planner-zoeken: GHL (API key + location) en Supabase zijn niet geconfigureerd',
      meta: plannerSearchMeta({ hasGhl, hasSb, totalResults: 0 }),
    };
  }

  const today = formatYyyyMmDdInAmsterdam(new Date());
  const startDate = addAmsterdamCalendarDays(today, -dateDaysBack);
  const endDate = addAmsterdamCalendarDays(today, dateDaysForward);

  const sbPromise = searchPlannerAppointmentsSupabase(qTrim, {
    startDate,
    endDate,
    limitPerQuery: Math.min(36, maxResults + 10),
  });

  let ghlError = null;
  const out = [];

  if (hasGhl) {
    const contactsUrl =
      `${GHL_BASE}/contacts/` +
      `?locationId=${encodeURIComponent(locationId)}` +
      `&query=${encodeURIComponent(qTrim)}` +
      `&limit=${limitContacts}`;

    let contacts = [];
    try {
      const contactsRes = await fetchWithRetry(contactsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version: '2021-04-15',
        },
      });
      const contactsData = await contactsRes.json().catch(() => ({}));
      contacts = Array.isArray(contactsData?.contacts) ? contactsData.contacts : [];
      if (!contactsRes.ok) {
        const msg = contactsData?.message || contactsData?.error || `contacts_${contactsRes.status}`;
        ghlError = String(msg).slice(0, 200);
      }
    } catch (err) {
      console.error('[planner-search] contacts fetch error:', err);
      ghlError = String(err?.message || err || 'fetch_failed').slice(0, 200);
    }

    for (const contact of contacts) {
      const cid = contact.id;
      if (!cid) continue;

      let reservations = [];
      try {
        reservations = await listReservationsForContact(cid);
      } catch (err) {
        console.warn('[planner-search] listReservationsForContact', cid, err?.message || err);
        reservations = [];
      }
      const filtered = reservations.filter((r) => r.dateStr >= startDate && r.dateStr <= endDate);

      const name =
        [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || '';
      const address = readCanonicalAddressLine(contact) || contact.address1 || '';
      const phone = String(contact.phone || contact.phoneNumber || '').trim();
      const notes = String(contact.notes || contact.additionalNotes || '').trim();

      if (filtered.length === 0) {
        out.push({
          id: `search:${cid}:no-appt`,
          contactId: cid,
          name,
          address,
          phone: phone || null,
          notes: notes || null,
          date: null,
          timeSlot: null,
          status: null,
          type: null,
        });
      } else {
        for (const r of filtered) {
          const blockLabel = r.block === 'morning' ? '09:00 - 13:00' : '13:00 - 17:00';
          out.push({
            id: `search:${cid}:${r.dateStr}:${r.block}`,
            contactId: cid,
            name,
            address,
            phone: phone || null,
            notes: notes || null,
            date: r.dateStr,
            timeSlot: blockLabel,
            status: r.status === 'cancelled' ? 'geannuleerd' : 'bevestigd',
            type: r.workType || null,
          });
        }
      }
    }
  }

  let sbRows = [];
  try {
    sbRows = await sbPromise;
  } catch (err) {
    console.warn('[planner-search] supabase await', err?.message || err);
    sbRows = [];
  }

  const merged = mergePlannerSearchResults(sbRows, out, maxResults);
  const meta = plannerSearchMeta({ hasGhl, hasSb, totalResults: merged.length });

  if (merged.length > 0) {
    return { results: merged, meta };
  }
  if (ghlError) {
    return { results: [], error: ghlError, meta };
  }
  return { results: merged, meta };
}
