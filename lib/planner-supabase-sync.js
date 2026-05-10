import { fetchWithRetry } from './retry.js';

function stripUrl(s) {
  return String(s ?? '').replace(/\/$/, '');
}

function toText(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeDayPart(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'afternoon' ? 'afternoon' : 'morning';
}

function normalizePriceLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((row, idx) => {
      const desc = toText(row?.desc ?? row?.label ?? row?.name ?? row?.description);
      const quantityRaw = Number(row?.quantity ?? row?.qty ?? 1);
      const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;
      const unitPrice = toNumber(row?.price ?? row?.unitPrice ?? row?.unit_price);
      const totalPriceRaw = toNumber(row?.total_price ?? row?.totalPrice);
      const totalPrice = totalPriceRaw ?? (unitPrice !== null ? Math.round(unitPrice * quantity * 100) / 100 : null);
      return {
        line_index: idx,
        description: desc,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        raw_payload: row && typeof row === 'object' ? row : null,
      };
    })
    .filter((row) => row.description || row.unit_price !== null || row.total_price !== null);
}

function fallbackExternalId(input) {
  const key = [
    toText(input.source),
    toText(input.ghlContactId),
    toText(input.date),
    normalizeDayPart(input.dayPart),
    toText(input.address),
  ]
    .filter(Boolean)
    .join('|');
  return key || null;
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
    throw new Error(`Supabase sync ${res.status}: ${txt.slice(0, 260)}`);
  }
  const txt = await res.text().catch(() => '');
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function upsertCustomer(base, key, input) {
  const ghlContactId = toText(input.ghlContactId);
  const email = toText(input.email)?.toLowerCase() || null;
  const payload = {
    ghl_contact_id: ghlContactId,
    name: toText(input.customerName),
    phone: toText(input.phone),
    email,
    address: toText(input.address),
  };
  if (!ghlContactId && !email) return null;

  if (ghlContactId) {
    const existing = await restJson(
      base,
      key,
      `/customers?select=id&ghl_contact_id=eq.${encodeURIComponent(ghlContactId)}&limit=1`
    );
    if (Array.isArray(existing) && existing[0]?.id) {
      await restJson(base, key, `/customers?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: 'PATCH',
        body: payload,
        prefer: 'return=minimal',
      });
      return existing[0].id;
    }
    const inserted = await restJson(base, key, '/customers', {
      method: 'POST',
      body: payload,
      prefer: 'return=representation',
    });
    return Array.isArray(inserted) && inserted[0]?.id ? inserted[0].id : null;
  }

  const existing = await restJson(base, key, `/customers?select=id&email=eq.${encodeURIComponent(email)}&limit=1`);
  if (Array.isArray(existing) && existing[0]?.id) {
    await restJson(base, key, `/customers?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: 'PATCH',
      body: payload,
      prefer: 'return=minimal',
    });
    return existing[0].id;
  }
  const inserted = await restJson(base, key, '/customers', {
    method: 'POST',
    body: payload,
    prefer: 'return=representation',
  });
  return Array.isArray(inserted) && inserted[0]?.id ? inserted[0].id : null;
}

async function upsertAppointment(base, key, input, customerId) {
  const externalBookingId = toText(input.externalBookingId || input.reservationId);
  const payload = {
    source: toText(input.source),
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
  if (payload.external_booking_id) {
    existing = await restJson(
      base,
      key,
      `/appointments?select=id&external_booking_id=eq.${encodeURIComponent(payload.external_booking_id)}&limit=1`
    );
  }
  if (!Array.isArray(existing) || !existing[0]?.id) {
    existing = await restJson(
      base,
      key,
      `/appointments?select=id&source=eq.${encodeURIComponent(String(payload.source || ''))}&ghl_contact_id=eq.${encodeURIComponent(
        String(payload.ghl_contact_id || '')
      )}&service_date=eq.${encodeURIComponent(String(payload.service_date || ''))}&day_part=eq.${encodeURIComponent(
        String(payload.day_part || '')
      )}&limit=1`
    );
  }
  if (Array.isArray(existing) && existing[0]?.id) {
    await restJson(base, key, `/appointments?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: 'PATCH',
      body: payload,
      prefer: 'return=minimal',
    });
    return existing[0].id;
  }
  const inserted = await restJson(base, key, '/appointments', {
    method: 'POST',
    body: payload,
    prefer: 'return=representation',
  });
  return Array.isArray(inserted) && inserted[0]?.id ? inserted[0].id : null;
}

async function replaceAppointmentPriceLines(base, key, appointmentId, priceLines) {
  if (!appointmentId) return 0;
  const normalized = normalizePriceLines(priceLines);
  await restJson(base, key, `/appointment_price_lines?appointment_id=eq.${encodeURIComponent(appointmentId)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
  if (!normalized.length) return 0;
  const rows = normalized.map((row) => ({ appointment_id: appointmentId, ...row }));
  await restJson(base, key, '/appointment_price_lines', {
    method: 'POST',
    body: rows,
    prefer: 'return=minimal',
  });
  return rows.length;
}

export async function syncAppointmentToSupabase(input = {}) {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    return { ok: false, skipped: true, reason: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' };
  }
  const base = `${stripUrl(url)}/rest/v1`;
  const customerId = await upsertCustomer(base, key, input);
  const appointmentId = await upsertAppointment(base, key, input, customerId);
  const priceLineCount = await replaceAppointmentPriceLines(base, key, appointmentId, input.priceLines);
  return { ok: true, skipped: false, customerId, appointmentId, priceLineCount };
}
