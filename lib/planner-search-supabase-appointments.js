/**
 * Zoekt in de Supabase **mirror** van planner-afspraken (`public.appointments` + `customers`),
 * dezelfde bron die o.a. `lib/analytics-supabase-read.js` en `planner-supabase-sync` gebruiken.
 *
 * Dit is **niet** identiek aan `loadPlannerAppointmentsSource` (GHL kalender-API per dag):
 * - Alleen rijen die naar Supabase gesynchroniseerd zijn, verschijnen hier.
 * - Wel: matches op **afspraakvelden** (probleem/omschrijving, adres, status, tijdvenster, datum),
 *   ook als de **klantnaam in GHL contacts** niet matcht met de zoekterm.
 */
import { fetchWithRetry } from './retry.js';
import { inferDashboardJobTypeFromWorkText } from './planning/appointment.js';

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

export function isPlannerSupabaseSearchConfigured() {
  return !!(String(process.env.SUPABASE_URL || '').trim() && String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
}

function safeIlikeToken(qRaw) {
  return String(qRaw || '')
    .trim()
    .replace(/[\x00-\x1f*%,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

async function restGetJsonArray(url, key) {
  const res = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Accept-Profile': 'public',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`supabase_rest_${res.status}: ${txt.slice(0, 180)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

/**
 * @param {string} qRaw
 * @param {{ startDate: string, endDate: string, limitPerQuery?: number }} bounds
 * @returns {Promise<object[]>} zelfde vorm als GHL-search hits (`id`, `contactId`, `name`, `address`, `date`, …)
 */
export async function searchPlannerAppointmentsSupabase(qRaw, bounds) {
  if (!isPlannerSupabaseSearchConfigured()) return [];
  const q = safeIlikeToken(qRaw);
  if (q.length < 2) return [];

  const url0 = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const base = `${stripUrl(url0)}/rest/v1`;
  const { startDate, endDate } = bounds;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) return [];

  const lim = Math.min(40, Math.max(8, Number(bounds.limitPerQuery) || 28));
  const pat = `*${q}*`;
  const pe = encodeURIComponent(pat);

  const sel = encodeURIComponent(
    'id,service_date,day_part,status,address,problem_description,ghl_contact_id,external_booking_id,customer_id,time_window'
  );
  const dateRange = `service_date=gte.${encodeURIComponent(startDate)}&service_date=lte.${encodeURIComponent(endDate)}`;

  const orAppt = `or=(problem_description.ilike.${pe},address.ilike.${pe},status.ilike.${pe},time_window.ilike.${pe})`;
  const orCust = `or=(name.ilike.${pe},phone.ilike.${pe})`;

  const byApptId = new Map();

  function workText(row) {
    return String(row?.problem_description ?? '').trim();
  }

  function mapRow(row, customerById) {
    const svc = String(row?.service_date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(svc)) return null;
    const custId = row?.customer_id != null ? String(row.customer_id).trim() : '';
    const cust = custId && customerById.has(custId) ? customerById.get(custId) : null;
    const name = String(cust?.name ?? '').trim() || '—';
    const phone = String(cust?.phone ?? '').trim() || null;
    const extId = String(row?.external_booking_id ?? '').trim();
    const ghlCid = String(row?.ghl_contact_id ?? '').trim();
    const tw = String(row?.time_window ?? '').trim();
    const block = String(row?.day_part ?? '').toLowerCase() === 'afternoon' ? 'afternoon' : 'morning';
    const slot = tw || (block === 'afternoon' ? '13:00 - 17:00' : '09:00 - 13:00');
    const wt = workText(row);
    const type = inferDashboardJobTypeFromWorkText(wt) || null;
    const id = extId || `supabase:${row.id}`;
    return {
      id,
      contactId: ghlCid || null,
      name,
      address: String(row?.address ?? '').trim(),
      phone,
      notes: wt || null,
      date: svc,
      timeSlot: slot,
      status: String(row?.status ?? '').trim() || null,
      type,
      _source: 'supabase_appointments',
    };
  }

  async function ingest(rows, customerById) {
    for (const row of rows || []) {
      const m = mapRow(row, customerById);
      if (!m) continue;
      const key = String(row?.id ?? '').trim();
      if (key) byApptId.set(key, m);
    }
  }

  const customerById = new Map();

  try {
    const custHits = await restGetJsonArray(`${base}/customers?select=id,name,phone&${orCust}&limit=15`, key);
    for (const c of custHits) {
      if (c?.id) customerById.set(String(c.id), c);
    }

    const apptOr = await restGetJsonArray(
      `${base}/appointments?select=${sel}&${dateRange}&${orAppt}&limit=${lim}`,
      key
    );
    const needCustIds = new Set();
    for (const r of apptOr) {
      const cid = r?.customer_id != null ? String(r.customer_id).trim() : '';
      if (cid && !customerById.has(cid)) needCustIds.add(cid);
    }
    if (needCustIds.size) {
      const inList = [...needCustIds].map(encodeURIComponent).join(',');
      const extra = await restGetJsonArray(`${base}/customers?select=id,name,phone&id=in.(${inList})`, key);
      for (const c of extra) {
        if (c?.id) customerById.set(String(c.id), c);
      }
    }
    await ingest(apptOr, customerById);

    if (custHits.length) {
      const inList = custHits.map((c) => encodeURIComponent(c.id)).filter(Boolean).join(',');
      if (inList) {
        const byCust = await restGetJsonArray(
          `${base}/appointments?select=${sel}&${dateRange}&customer_id=in.(${inList})&limit=${lim}`,
          key
        );
        const need2 = new Set();
        for (const r of byCust) {
          const cid = r?.customer_id != null ? String(r.customer_id).trim() : '';
          if (cid && !customerById.has(cid)) need2.add(cid);
        }
        if (need2.size) {
          const in2 = [...need2].map(encodeURIComponent).join(',');
          const ex2 = await restGetJsonArray(`${base}/customers?select=id,name,phone&id=in.(${in2})`, key);
          for (const c of ex2) {
            if (c?.id) customerById.set(String(c.id), c);
          }
        }
        await ingest(byCust, customerById);
      }
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(qRaw.trim())) {
      const d = qRaw.trim();
      const onDay = await restGetJsonArray(
        `${base}/appointments?select=${sel}&service_date=eq.${encodeURIComponent(d)}&limit=${lim}`,
        key
      );
      const need3 = new Set();
      for (const r of onDay) {
        const cid = r?.customer_id != null ? String(r.customer_id).trim() : '';
        if (cid && !customerById.has(cid)) need3.add(cid);
      }
      if (need3.size) {
        const in3 = [...need3].map(encodeURIComponent).join(',');
        const ex3 = await restGetJsonArray(`${base}/customers?select=id,name,phone&id=in.(${in3})`, key);
        for (const c of ex3) {
          if (c?.id) customerById.set(String(c.id), c);
        }
      }
      await ingest(onDay, customerById);
    }
  } catch (err) {
    console.warn('[planner-search][supabase]', err?.message || err);
    return [];
  }

  return [...byApptId.values()];
}
