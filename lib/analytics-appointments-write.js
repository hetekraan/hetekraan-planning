import { listPrices } from './prices-store.js';
import { computeAppointmentAnalytics, buildPriceMaps } from './planner-appointment-totals.js';
import { upsertAnalyticsAppointmentRecord } from './analytics-appointments-cache.js';

function normalizeYmd(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normalizePriceLines(priceLines) {
  return (Array.isArray(priceLines) ? priceLines : []).map((line) => ({
    desc: String(line?.desc || line?.description || line?.label || line?.name || '').trim(),
    price: Number(line?.price || 0),
    sku: String(line?.sku || '').trim() || null,
    priceId: String(line?.priceId || line?.price_id || '').trim() || null,
  }));
}

export async function cacheAppointmentAnalyticsFromPriceLines(input = {}) {
  const appointmentId = String(input.appointmentId || '').trim();
  const date = normalizeYmd(input.date);
  if (!appointmentId || !date) return { ok: false, skipped: true, reason: 'appointmentId/date missing' };
  const locId = String(input.locId || process.env.GHL_LOCATION_ID || 'default').trim() || 'default';
  const priceRows = await listPrices(locId).catch(() => []);
  const maps = buildPriceMaps(Array.isArray(priceRows) ? priceRows : []);
  const fakeAppointment = {
    price: Number(input.basePrice || 0),
    extras: normalizePriceLines(input.priceLines),
  };
  const analytics = computeAppointmentAnalytics(fakeAppointment, maps);
  await upsertAnalyticsAppointmentRecord({
    appointmentId,
    date,
    totalRevenueExcl: analytics.totalRevenueExcl,
    totalCost: analytics.totalCost,
    margin: analytics.margin,
    marginPct: analytics.marginPct,
    costKnown: analytics.costKnown,
  });
  return { ok: true, skipped: false, analytics };
}
