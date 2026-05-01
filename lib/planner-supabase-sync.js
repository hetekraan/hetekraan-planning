import { getSupabaseAdminClient } from './supabase.js';

function toText(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeDayPart(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'afternoon') return 'afternoon';
  return 'morning';
}

function normalizePriceLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((row, idx) => {
      const desc = toText(row?.desc || row?.label || row?.name);
      const quantityRaw = Number(row?.quantity ?? row?.qty ?? row?.amount ?? 1);
      const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;
      const unitPrice = toNumber(row?.price ?? row?.unitPrice);
      const totalPrice = unitPrice !== null ? Math.round(unitPrice * quantity * 100) / 100 : null;
      return {
        line_index: idx,
        description: desc,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        raw_payload: row && typeof row === 'object' ? row : null,
      };
    })
    .filter((row) => row.description || row.unit_price !== null);
}

function fallbackExternalId(input) {
  const hashInput = [
    toText(input.source),
    toText(input.ghlContactId),
    toText(input.date),
    toText(input.dayPart),
    toText(input.address),
  ]
    .filter(Boolean)
    .join('|');
  return hashInput || null;
}

async function upsertCustomer(client, input) {
  const ghlContactId = toText(input.ghlContactId);
  const email = toText(input.email)?.toLowerCase() || null;
  const customerPayload = {
    ghl_contact_id: ghlContactId,
    name: toText(input.customerName),
    phone: toText(input.phone),
    email,
    address: toText(input.address),
  };

  if (!ghlContactId && !email) return null;

  let existing = null;
  if (ghlContactId) {
    const { data, error } = await client
      .from('customers')
      .select('id')
      .eq('ghl_contact_id', ghlContactId)
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }

  if (!existing?.id && email) {
    const { data, error } = await client
      .from('customers')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }

  if (existing?.id) {
    const { error: updateErr } = await client
      .from('customers')
      .update(customerPayload)
      .eq('id', existing.id);
    if (updateErr) throw updateErr;
    return existing.id;
  }

  const { data, error } = await client
    .from('customers')
    .insert(customerPayload)
    .select('id')
    .single();
  if (error) throw error;
  return data?.id || null;
}

async function upsertAppointment(client, input, customerId) {
  const source = toText(input.source);
  const externalBookingId = toText(input.externalBookingId || input.reservationId);
  const appointmentPayload = {
    source,
    external_booking_id: externalBookingId || fallbackExternalId(input),
    ghl_contact_id: toText(input.ghlContactId),
    customer_id: customerId,
    address: toText(input.address),
    service_date: toText(input.date),
    day_part: normalizeDayPart(input.dayPart),
    time_window: toText(input.timeWindow),
    status: toText(input.status) || 'confirmed',
    problem_description: toText(input.problemDescription),
    total_amount: toNumber(input.totalAmount),
    raw_payload: input.rawPayload && typeof input.rawPayload === 'object' ? input.rawPayload : null,
  };

  let existing = null;
  if (externalBookingId) {
    const { data, error } = await client
      .from('appointments')
      .select('id')
      .eq('external_booking_id', externalBookingId)
      .maybeSingle();
    if (error) throw error;
    existing = data;
  } else {
    const { data, error } = await client
      .from('appointments')
      .select('id')
      .eq('source', appointmentPayload.source)
      .eq('ghl_contact_id', appointmentPayload.ghl_contact_id)
      .eq('service_date', appointmentPayload.service_date)
      .eq('day_part', appointmentPayload.day_part)
      .eq('address', appointmentPayload.address)
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }

  if (existing?.id) {
    const { error: updateErr } = await client
      .from('appointments')
      .update(appointmentPayload)
      .eq('id', existing.id);
    if (updateErr) throw updateErr;
    return existing.id;
  }

  const { data, error } = await client
    .from('appointments')
    .insert(appointmentPayload)
    .select('id')
    .single();
  if (error) throw error;
  return data?.id || null;
}

async function replaceAppointmentPriceLines(client, appointmentId, priceLines) {
  if (!appointmentId) return 0;
  const normalized = normalizePriceLines(priceLines);
  const { error: deleteErr } = await client
    .from('appointment_price_lines')
    .delete()
    .eq('appointment_id', appointmentId);
  if (deleteErr) throw deleteErr;

  if (!normalized.length) return 0;

  const rows = normalized.map((line) => ({
    appointment_id: appointmentId,
    ...line,
  }));
  const { error: insertErr } = await client.from('appointment_price_lines').insert(rows);
  if (insertErr) throw insertErr;
  return rows.length;
}

export async function syncAppointmentToSupabase(input = {}) {
  const supabase = getSupabaseAdminClient();
  if (!supabase.enabled || !supabase.client) {
    return { ok: false, skipped: true, reason: supabase.reason || 'disabled' };
  }

  const customerId = await upsertCustomer(supabase.client, input);
  const appointmentId = await upsertAppointment(supabase.client, input, customerId);
  const priceLineCount = await replaceAppointmentPriceLines(supabase.client, appointmentId, input.priceLines);
  return {
    ok: true,
    skipped: false,
    customerId,
    appointmentId,
    priceLineCount,
  };
}

