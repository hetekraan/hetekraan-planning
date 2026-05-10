import { fetchWithRetry } from './retry.js';

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

function toYmd(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  return { base: `${stripUrl(url)}/rest/v1`, key };
}

async function restJson(base, key, path, options = {}) {
  const res = await fetchWithRetry(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Accept-Profile': 'public',
      ...(options.prefer ? { Prefer: options.prefer } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`analytics_appointments ${res.status}: ${txt.slice(0, 260)}`);
  }
  const txt = await res.text().catch(() => '');
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export async function upsertAnalyticsAppointmentRecord(input = {}) {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, skipped: true, reason: 'SUPABASE env missing' };
  const appointmentId = String(input.appointmentId || '').trim();
  const date = toYmd(input.date);
  if (!appointmentId || !date) {
    return { ok: false, skipped: true, reason: 'appointmentId/date missing' };
  }
  const row = {
    appointmentId,
    date,
    totalRevenueExcl: toNum(input.totalRevenueExcl),
    totalCost: toNum(input.totalCost),
    margin: toNum(input.margin),
    marginPct: toNum(input.marginPct),
    costKnown: input.costKnown === true,
    updatedAt: new Date().toISOString(),
  };
  await restJson(
    cfg.base,
    cfg.key,
    '/analytics_appointments?on_conflict=appointmentId',
    {
      method: 'POST',
      body: row,
      prefer: 'resolution=merge-duplicates,return=minimal',
    }
  );
  return { ok: true, skipped: false };
}

export async function listAnalyticsAppointmentsByDateRange(startDate, endDate) {
  const cfg = getSupabaseConfig();
  if (!cfg) return [];
  const start = toYmd(startDate);
  const end = toYmd(endDate);
  if (!start || !end) return [];
  const path = `/analytics_appointments?select=appointmentId,date,totalRevenueExcl,totalCost,margin,marginPct,costKnown,updatedAt&date=gte.${encodeURIComponent(
    start
  )}&date=lte.${encodeURIComponent(end)}&order=date.asc`;
  const rows = await restJson(cfg.base, cfg.key, path).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}
