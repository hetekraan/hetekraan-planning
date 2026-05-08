/**
 * Primaire read-path voor planner: één Supabase-query (appointments + price lines + customer).
 * Wordt gecombineerd met bestaande GHL/Redis-enrich; stubs dragen _hkSupabaseOverlay voor velden
 * die uit de mirror komen (werk, prijs, regels, adres, tijdvenster).
 */

import { amsterdamWallTimeToDate } from './amsterdam-wall-time.js';
import { ghlDurationMinutesForType, normalizeWorkType, plannedMinutesForType } from './booking-blocks.js';
import { splitAddressLineToStraatHuis } from './ghl-contact-canonical.js';
import { canonicalGhlEventId } from './planning/ghl-event-core.js';
import { getSupabaseAdminClient } from './supabase.js';

function toStr(v) {
  return String(v ?? '').trim();
}

/** PostgREST embed kan één object of (bij ambiguïteit) array zijn. */
function resolveEmbeddedCustomer(row) {
  const c = row?.customers;
  if (Array.isArray(c)) return c[0] && typeof c[0] === 'object' ? c[0] : null;
  return c && typeof c === 'object' ? c : null;
}

function sortPriceLines(lines) {
  if (!Array.isArray(lines)) return [];
  return [...lines].sort((a, b) => {
    const ia = Number.isFinite(Number(a?.line_index)) ? Number(a.line_index) : 0;
    const ib = Number.isFinite(Number(b?.line_index)) ? Number(b.line_index) : 0;
    return ia - ib;
  });
}

function priceLinesToExtras(priceLines) {
  const sorted = sortPriceLines(priceLines);
  return sorted.map((row) => {
    const q = Number(row?.quantity);
    const qty = Number.isFinite(q) && q > 0 ? q : 1;
    const unit = Number(row?.unit_price);
    const total = Number(row?.total_price);
    let price = Number.isFinite(unit) ? unit * qty : NaN;
    if (!Number.isFinite(price) && Number.isFinite(total)) price = total;
    if (!Number.isFinite(price)) price = 0;
    return {
      desc: toStr(row?.description),
      price: Math.round(price * 100) / 100,
    };
  });
}

function totalAmountToPriceRaw(totalAmount) {
  if (totalAmount == null || totalAmount === '') return '';
  const n = Number(totalAmount);
  if (!Number.isFinite(n)) return '';
  return String(n);
}

/**
 * Na GHL-enrich: overschrijf parsed* met mirror-data zodat UI gelijk blijft met dual-write bron.
 * @param {object} e — enriched event
 * @param {object} overlay — zie buildOverlayFromAppointmentRow
 */
export function applySupabaseMirrorOverlayToEvent(e, overlay) {
  if (!e || !overlay || typeof overlay !== 'object') return;
  const prob = toStr(overlay.problemDescription);
  if (prob) {
    e.parsedWork = prob;
    e.title = prob;
  }
  const tw = overlay.timeWindow != null ? String(overlay.timeWindow).trim() : '';
  if (tw) e.parsedTimeWindow = tw;
  const pr = overlay.totalAmountRaw != null ? String(overlay.totalAmountRaw).trim() : '';
  if (pr !== '') e.parsedPrice = pr;
  if (Array.isArray(overlay.extras)) e.parsedExtras = overlay.extras;
  const addr = toStr(overlay.addressLine);
  if (addr) {
    const split = splitAddressLineToStraatHuis(addr);
    e.parsedStraatnaam = split.straatnaam || addr;
    e.parsedHuisnummer = split.huisnummer || '';
    e.parsedPostcode = '';
    e.parsedWoonplaats = '';
  }
  if (overlay.invoiceFields && typeof overlay.invoiceFields === 'object') {
    e.invoiceFields = { ...(e.invoiceFields || {}), ...overlay.invoiceFields };
  }
  if (overlay.parsedPaymentStatus != null) {
    e.parsedPaymentStatus = String(overlay.parsedPaymentStatus || '');
  }
}

function buildOverlayFromAppointmentRow(row) {
  const lines = row?.appointment_price_lines;
  const extras = priceLinesToExtras(Array.isArray(lines) ? lines : []);
  const raw = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  const cust = resolveEmbeddedCustomer(row);
  const addr =
    toStr(row?.address) ||
    toStr(cust?.address) ||
    toStr(raw?.addressSnapshot) ||
    '';
  return {
    problemDescription: toStr(row?.problem_description),
    totalAmountRaw: totalAmountToPriceRaw(row?.total_amount),
    timeWindow: row?.time_window != null ? String(row.time_window) : '',
    addressLine: addr,
    extras,
    invoiceFields: raw.invoiceFields && typeof raw.invoiceFields === 'object' ? raw.invoiceFields : null,
    parsedPaymentStatus: raw.parsedPaymentStatus != null ? raw.parsedPaymentStatus : null,
  };
}

function isLegacyV1TimedRow(row) {
  const raw = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  return raw.bookingModel === 'legacy_v1_timed_appt';
}

function ghlAppointmentIdFromRow(row) {
  const raw = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  const id = raw.ghlAppointmentId ?? raw.response?.appointmentId ?? null;
  return id != null && String(id).trim() ? String(id).trim() : '';
}

function buildMinimalGhlLikeContact(row, ghlContactId) {
  const c = resolveEmbeddedCustomer(row);
  const name = toStr(c?.name);
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    id: ghlContactId,
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
    phone: toStr(c?.phone),
    email: toStr(c?.email).toLowerCase() || '',
    customFields: [],
  };
}

function buildStubFromRow(row, dateStr) {
  const cid = toStr(row?.ghl_contact_id);
  if (!cid) return null;

  const dayPartNorm = String(row?.day_part || 'morning').toLowerCase() === 'afternoon' ? 'afternoon' : 'morning';
  const block = dayPartNorm;
  const legacyV1 = isLegacyV1TimedRow(row);
  const workText = toStr(row?.problem_description) || 'Werkzaamheden';
  const wType = normalizeWorkType(workText);
  const hour = block === 'morning' ? 10 : 14;
  const start = dateStr ? amsterdamWallTimeToDate(dateStr, hour, 0) : null;
  let startMs = start ? start.getTime() : NaN;
  let endMs = NaN;
  let title = workText;
  let id = '';

  if (legacyV1) {
    const ghlId = ghlAppointmentIdFromRow(row) || toStr(row?.external_booking_id);
    if (!ghlId) return null;
    id = ghlId;
    const durMin = ghlDurationMinutesForType(wType);
    const mStart = dateStr ? amsterdamWallTimeToDate(dateStr, block === 'morning' ? 8 : 14, 0) : null;
    startMs = mStart ? mStart.getTime() : NaN;
    endMs = Number.isFinite(startMs) ? startMs + durMin * 60 * 1000 : NaN;
  } else {
    const durMin = plannedMinutesForType(wType);
    title = `__hk_block_res__ ${wType}`;
    id = `hk-b1:${cid}:${dateStr}`;
    endMs = Number.isFinite(startMs) ? startMs + durMin * 60 * 1000 : NaN;
  }

  const overlay = buildOverlayFromAppointmentRow(row);
  const contact = buildMinimalGhlLikeContact(row, cid);

  return {
    id,
    startTime: startMs,
    endTime: endMs,
    title,
    contactId: cid,
    contact,
    _hkBlockReservationSynthetic: !legacyV1,
    _hkSyntheticBlock: block,
    _hkSupabaseMirror: true,
    _hkSupabaseOverlay: overlay,
  };
}

/**
 * @param {string} dateStr — YYYY-MM-DD
 * @returns {Promise<{
 *   shouldUse: boolean,
 *   stubs: object[],
 *   sbGhlEventIds: Set<string>,
 *   redisContactSkip: Set<string>,
 *   fallbackReason: string | null,
 * }>}
 */
export async function readSupabasePlannerMirrorForDate(dateStr) {
  const empty = {
    shouldUse: false,
    stubs: [],
    sbGhlEventIds: new Set(),
    redisContactSkip: new Set(),
    fallbackReason: null,
  };

  const supabase = getSupabaseAdminClient();
  if (!supabase?.enabled || !supabase?.client) {
    return { ...empty, fallbackReason: 'supabase_disabled' };
  }

  let rows = null;
  try {
    const { data, error } = await supabase.client
      .from('appointments')
      .select(
        `
        *,
        customers (*),
        appointment_price_lines (*)
      `
      )
      .eq('service_date', dateStr)
      .or('status.is.null,status.neq.cancelled');

    if (error) {
      return { ...empty, fallbackReason: `query_error:${error.message || 'unknown'}` };
    }
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    return { ...empty, fallbackReason: `exception:${String(err?.message || err)}` };
  }

  if (rows.length === 0) {
    return { ...empty, fallbackReason: 'empty' };
  }

  const stubs = [];
  const sbGhlEventIds = new Set();
  const redisContactSkip = new Set();

  for (const row of rows) {
    const stub = buildStubFromRow(row, dateStr);
    if (!stub) continue;
    stubs.push(stub);
    const cid = toStr(row?.ghl_contact_id);
    if (cid) redisContactSkip.add(cid);
    if (isLegacyV1TimedRow(row)) {
      const gid = ghlAppointmentIdFromRow(row) || toStr(row?.external_booking_id);
      if (gid) sbGhlEventIds.add(gid);
    }
  }

  if (stubs.length === 0) {
    return { ...empty, fallbackReason: 'no_valid_rows' };
  }

  return {
    shouldUse: true,
    stubs,
    sbGhlEventIds,
    redisContactSkip,
    fallbackReason: null,
  };
}

export function isSupabasePlannerReadEnabled() {
  return String(process.env.ENABLE_SUPABASE_READ || '').trim().toLowerCase() === 'true';
}

/** Filter GHL-kalender events die al als legacy v1 in de mirror zitten. */
export function filterGhlEventsForSupabaseMirror(events, sbGhlEventIds) {
  if (!Array.isArray(events) || !sbGhlEventIds || sbGhlEventIds.size === 0) return events;
  return events.filter((e) => !sbGhlEventIds.has(canonicalGhlEventId(e)));
}
