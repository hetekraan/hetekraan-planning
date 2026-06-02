import { fetchWithRetry } from './retry.js';

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

function toText(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function toYmd(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normalizePriceLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    desc: String(line?.desc ?? line?.description ?? line?.label ?? line?.name ?? '').trim(),
    price: toNumber(line?.price ?? line?.unitPrice ?? line?.unit_price) ?? 0,
    quantity: toNumber(line?.quantity ?? line?.qty) ?? 1,
    sku: toText(line?.sku),
    priceId: toText(line?.priceId ?? line?.price_id),
    raw_payload: line && typeof line === 'object' ? line : null,
  }));
}

export function buildAppointmentSnapshot(input = {}) {
  const contactId = toText(input.contactId);
  const serviceDate = toYmd(input.serviceDay || input.routeDate);
  const routeDate = toYmd(input.routeDate);
  const completedAt = toText(input.completedAt) || new Date().toISOString();
  const completedAtMs = Date.parse(completedAt);
  const appointmentId = toText(input.appointmentId);
  const syntheticAppointmentId =
    appointmentId || (contactId && serviceDate ? `hk-b1:${contactId}:${serviceDate}` : null);
  const priceLines = normalizePriceLines(input.priceLines);
  const contactSnapshot =
    input.contactSnapshot && typeof input.contactSnapshot === 'object' ? input.contactSnapshot : null;

  const snapshotId = [
    'snap',
    contactId || 'unknown',
    serviceDate || 'nodate',
    String(Number.isFinite(completedAtMs) ? completedAtMs : Date.now()),
  ].join('_');

  const payload = {
    snapshot_version: 1,
    source: 'planner_complete',
    contact_id: contactId,
    appointment_id: appointmentId,
    synthetic_appointment_id: syntheticAppointmentId,
    service_date: serviceDate,
    route_date: routeDate,
    completed_at: completedAt,
    type: toText(input.type),
    status: 'klaar',
    betaal_status: 'Afgerond',
    appointment_desc: toText(input.appointmentDesc),
    base_price: toNumber(input.basePrice),
    prijs_totaal: toNumber(input.totalPrice),
    prijs_regels: priceLines,
    review_mail_requested: input.sendReview === true,
    contact_snapshot: contactSnapshot,
    raw_request: input.rawRequest && typeof input.rawRequest === 'object' ? input.rawRequest : null,
  };

  return {
    snapshot_id: snapshotId,
    snapshot_version: 1,
    source: 'planner_complete',
    ghl_contact_id: contactId,
    appointment_id: appointmentId,
    synthetic_appointment_id: syntheticAppointmentId,
    service_date: serviceDate,
    route_date: routeDate,
    completed_at: completedAt,
    status: 'klaar',
    type: toText(input.type),
    payment_status: 'Afgerond',
    appointment_desc: toText(input.appointmentDesc),
    base_price: toNumber(input.basePrice),
    total_amount: toNumber(input.totalPrice),
    contact_name: toText(contactSnapshot?.name),
    contact_email: toText(contactSnapshot?.email),
    contact_phone: toText(contactSnapshot?.phone),
    contact_address: toText(contactSnapshot?.address),
    payload,
  };
}

export async function writeAppointmentSnapshot(input = {}) {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    return { ok: false, skipped: true, reason: 'SUPABASE env missing' };
  }

  const row = buildAppointmentSnapshot(input);
  if (!row.ghl_contact_id || !row.service_date) {
    return { ok: false, skipped: true, reason: 'contact/date missing' };
  }

  const res = await fetchWithRetry(`${stripUrl(url)}/rest/v1/appointment_snapshots`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`appointment_snapshots ${res.status}: ${text.slice(0, 260)}`);
  }

  const json = await res.json().catch(() => null);
  return { ok: true, skipped: false, snapshot: Array.isArray(json) ? json[0] : json };
}
