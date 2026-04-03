// api/send-booking-invite.js
// Berekent de 2 beste tijdsloten voor een klant (op basis van adres + bestaande routes)
// en zet custom fields (+ optioneel tag) zodat een GHL-workflow het WhatsApp-template verstuurt.

import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  amsterdamWeekdaySun0,
  formatYyyyMmDdInAmsterdam,
  hourInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import { blockAllowsNewCustomerBooking, normalizeWorkType } from '../lib/booking-blocks.js';
import { fetchCalendarEventsForDay, maxCustomerAppointmentsPerDay } from '../lib/calendar-customer-cap.js';
import { fetchWithRetry } from '../lib/retry.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { signBookingToken } from '../lib/session.js';
import { availabilityDebugEnabled, logAvailability } from '../lib/availability-debug.js';
import {
  fetchBlockedSlotsAsEvents,
  ghlCalendarEventEndMs,
  ghlCalendarEventStartMs,
  isCustomerBookingBlockedOnAmsterdamDate,
  markBlockLikeOnCalendarEvents,
  resolveAssignedUserIdForBlockedSlotQueries,
} from '../lib/ghl-calendar-blocks.js';
import { DAYPART_SPLIT_HOUR } from '../lib/planning-work-hours.js';
import { ghlCalendarIdFromEnv, ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import { fetchGhlFreeSlotsObject, slotsObjectToConcreteList } from '../lib/ghl-free-slots-pipeline.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

/** Zelfde availability-context als confirm-booking / suggest-slots (Europe/Amsterdam-dag via GHL). */
function customerAvailabilityCtx() {
  return {
    locationId: GHL_LOCATION_ID,
    calendarId: ghlCalendarIdFromEnv(),
    apiKey: GHL_API_KEY,
    assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
  };
}

/** Publieke basis-URL voor boekingslinks */
function publicBaseUrl() {
  const fromEnv = process.env.BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return 'https://planning.hetekraan.nl';
}
const DAYS_AHEAD      = 7;

const FIELD_IDS = {
  straatnaam:     'ZwIMY4VPelG5rKROb5NR',
  huisnummer:     'co5Mr16rF6S6ay5hJOSJ',
  postcode:       '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:     'mFRQjlUppycMfyjENKF9',
  type_onderhoud: 'EXSQmlt7BqkXJMs8F3Qk',
};

function getField(contact, fieldId) {
  const f = contact?.customFields?.find(f => f.id === fieldId);
  return f?.value || '';
}

/** Zelfde overlap-logica als blockedSlotEventOverlapsMs (half-open vriendelijk: b0 < a1 && b1 > a0). */
function intervalOverlapsMs(a0, a1, b0, b1) {
  return b0 < a1 && b1 > a0;
}

/**
 * True als [slotStartMs, slotEndMs) een block-like of blocked-slots-interval raakt (merged `events`).
 * Ongeldige block-start (NaN) → conservatief true (gelijk aan dag-blok logica).
 */
function concreteSlotOverlapsAnyBlockLike(slotStartMs, slotEndMs, dayBounds, events) {
  if (
    !dayBounds ||
    !Number.isFinite(slotStartMs) ||
    !Number.isFinite(slotEndMs) ||
    slotEndMs <= slotStartMs ||
    !Array.isArray(events)
  ) {
    return false;
  }
  for (const e of events) {
    if (!e || !e._hkGhlBlockSlot) continue;
    const bs = ghlCalendarEventStartMs(e);
    let be = ghlCalendarEventEndMs(e);
    if (Number.isNaN(bs)) return true;
    if (Number.isNaN(be)) be = dayBounds.endMs;
    if (intervalOverlapsMs(slotStartMs, slotEndMs, bs, be)) return true;
  }
  return false;
}

/**
 * Twee concrete GHL free-slots (startMs/endMs), gefilterd op blok-capaciteit zoals confirm-booking.
 * Route-sorting uitgesteld — volgorde = vroegste beschikbare sloten.
 */
async function pickConcreteInviteSlots(workType) {
  if (!GHL_API_KEY) return [];
  const calId = ghlCalendarIdFromEnv();
  const locId = ghlLocationIdFromEnv();
  if (!calId || !locId) return [];

  const todayAmsterdam = formatYyyyMmDdInAmsterdam(new Date());
  if (!todayAmsterdam) return [];
  const startDate = addAmsterdamCalendarDays(todayAmsterdam, 1);
  if (!startDate) return [];
  const endDate = addAmsterdamCalendarDays(startDate, DAYS_AHEAD - 1);
  if (!endDate) return [];
  const startBounds = amsterdamCalendarDayBoundsMs(startDate);
  const endBounds = amsterdamCalendarDayBoundsMs(endDate);
  if (!startBounds || !endBounds) return [];

  const free = await fetchGhlFreeSlotsObject({
    calendarId: calId,
    locationId: locId,
    startMs: startBounds.startMs,
    endMs: endBounds.endMs,
    apiKey: GHL_API_KEY,
  });
  if (!free.ok || !free.slotsObj) return [];

  const concrete = slotsObjectToConcreteList(free.slotsObj, { calendarId: calId, workType });
  if (concrete.length === 0) return [];

  const dbg = availabilityDebugEnabled();
  const trace = dbg ? { flow: 'send-booking-invite', timeZone: 'Europe/Amsterdam', dayDecisions: [] } : null;

  const eventCache = new Map();
  /** Kalender-events + blocked-slots API, daarna markBlockLike — zelfde basis als dayHasCustomerBlockingOverlap. */
  async function loadDay(dateStr) {
    if (eventCache.has(dateStr)) return eventCache.get(dateStr);
    const dayBounds = amsterdamCalendarDayBoundsMs(dateStr);
    if (!dayBounds) {
      const empty = { events: [], dayBounds: null };
      eventCache.set(dateStr, empty);
      return empty;
    }
    const raw = await fetchCalendarEventsForDay(dateStr, {
      base: GHL_BASE,
      locationId: GHL_LOCATION_ID,
      calendarId: calId,
      apiKey: GHL_API_KEY,
    });
    const calEv = Array.isArray(raw) ? raw : [];
    const blockedMerged = await fetchBlockedSlotsAsEvents(GHL_BASE, {
      locationId: GHL_LOCATION_ID,
      calendarId: calId,
      startMs: dayBounds.startMs,
      endMs: dayBounds.endMs,
      apiKey: GHL_API_KEY,
      assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
    });
    const merged = calEv.concat(Array.isArray(blockedMerged) ? blockedMerged : []);
    markBlockLikeOnCalendarEvents(merged);
    const payload = { events: merged, dayBounds };
    eventCache.set(dateStr, payload);
    return payload;
  }

  const inMorning = (e) => {
    const raw = e?.startTime ?? e?.start;
    if (raw == null) return false;
    return hourInAmsterdam(raw) < DAYPART_SPLIT_HOUR;
  };
  const inAfternoon = (e) => {
    const raw = e?.startTime ?? e?.start;
    if (raw == null) return false;
    return hourInAmsterdam(raw) >= DAYPART_SPLIT_HOUR;
  };

  const picked = [];
  for (const slot of concrete) {
    const dow = amsterdamWeekdaySun0(slot.dateStr);
    if (dow === 0 || dow === 6) {
      if (trace) trace.dayDecisions.push({ dateStr: slot.dateStr, outcome: 'excluded', why: 'weekend' });
      continue;
    }

    if (await isCustomerBookingBlockedOnAmsterdamDate(GHL_BASE, customerAvailabilityCtx(), slot.dateStr)) {
      continue;
    }

    const dayPack = await loadDay(slot.dateStr);
    const { events, dayBounds } = dayPack;
    if (!dayBounds) continue;
    const customerEvents = events.filter((e) => !e._hkGhlBlockSlot);
    const dayCap = maxCustomerAppointmentsPerDay();
    const syntheticDay = picked.filter((p) => p.dateStr === slot.dateStr).length;
    if (customerEvents.length + syntheticDay >= dayCap) {
      if (trace) {
        trace.dayDecisions.push({
          dateStr: slot.dateStr,
          outcome: 'excluded',
          why: 'day_cap_would_exceed',
          slotStartMs: slot.startMs,
        });
      }
      continue;
    }

    let blockEvents = customerEvents.filter((e) =>
      slot.block === 'morning' ? inMorning(e) : inAfternoon(e)
    );
    for (const p of picked) {
      if (p.dateStr !== slot.dateStr || p.block !== slot.block) continue;
      blockEvents.push({
        startTime: p.startMs,
        endTime: p.endMs,
        title: '__picked_invite__',
      });
    }

    if (!blockAllowsNewCustomerBooking(slot.block, blockEvents, workType)) {
      if (trace) {
        trace.dayDecisions.push({
          dateStr: slot.dateStr,
          outcome: 'excluded',
          why: 'booking_rules_disallow_concrete_slot',
          part: slot.block,
          slotStartMs: slot.startMs,
        });
      }
      continue;
    }

    if (concreteSlotOverlapsAnyBlockLike(slot.startMs, slot.endMs, dayBounds, events)) {
      if (availabilityDebugEnabled()) {
        logAvailability('invite_concrete_slot_excluded_block_overlap', {
          dateStr: slot.dateStr,
          slotStartMs: slot.startMs,
          slotEndMs: slot.endMs,
          reason: 'interval_overlaps_block_like_or_blocked_slot_row',
        });
      }
      if (trace) {
        trace.dayDecisions.push({
          dateStr: slot.dateStr,
          outcome: 'excluded',
          why: 'concrete_overlaps_block_interval',
          slotStartMs: slot.startMs,
          slotEndMs: slot.endMs,
        });
      }
      continue;
    }

    picked.push(slot);
    if (picked.length >= 2) break;
  }

  if (trace) {
    logAvailability('invite_booking_flow_summary', {
      ...trace,
      offeredToClient: picked.map((c) => ({ dateStr: c.dateStr, block: c.block, startMs: c.startMs })),
      source: 'ghl_free_slots_pipeline',
    });
  }
  return picked;
}

function parseRequestBody(req) {
  if (req.method !== 'POST') return req.query || {};
  let b = req.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return {};
    }
  }
  return b && typeof b === 'object' ? b : {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = parseRequestBody(req);
  let { contactId, name: nameParam, phone: phoneParam, address: addressParam, type: typeParam, workType: workTypeParam } = body;

  // Zoek contact op naam of telefoon als er geen contactId is
  if (!contactId) {
    const searchPhone = (phoneParam || '').replace(/\s/g, '');
    if (searchPhone) {
      const sr = await fetch(
        `${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(searchPhone)}`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
      );
      if (sr.ok) contactId = (await sr.json())?.contact?.id || null;
    }
    if (!contactId && nameParam) {
      const nr = await fetch(
        `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(nameParam)}&limit=1`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
      );
      if (nr.ok) contactId = (await nr.json())?.contacts?.[0]?.id || null;
    }
    // Maak nieuw contact aan als niet gevonden
    if (!contactId && (nameParam || phoneParam)) {
      const parts = (nameParam || '').trim().split(' ');
      const cc = await fetch(`${GHL_BASE}/contacts/`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
        body: JSON.stringify({
          locationId: GHL_LOCATION_ID,
          firstName: parts[0] || nameParam,
          lastName: parts.slice(1).join(' ') || '',
          phone: normalizeNlPhone((phoneParam || '').replace(/\s/g, '')) || (phoneParam || '').replace(/\s/g, '') || '',
          address1: addressParam || '',
        })
      });
      if (cc.ok) contactId = (await cc.json())?.contact?.id || null;
    }
  }

  if (!contactId) return res.status(400).json({ error: 'Kon geen contact vinden of aanmaken' });

  // Haal contactgegevens op
  const cr = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  if (!cr.ok) return res.status(404).json({ error: 'Contact niet gevonden' });

  const cd      = await cr.json();
  const contact = cd?.contact || cd;
  const name    = contact.firstName
    ? `${contact.firstName} ${contact.lastName || ''}`.trim()
    : (contact.name || nameParam || 'Klant');
  const firstName = contact.firstName || name.split(' ')[0];

  const straat     = getField(contact, FIELD_IDS.straatnaam);
  const huisnr     = getField(contact, FIELD_IDS.huisnummer);
  const postcode   = getField(contact, FIELD_IDS.postcode);
  const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
  const address    = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ')
    || contact.address1 || addressParam || '';

  /** E164-mobiel: formulier wint (suggest vult 06… in terwijl GHL-contact soms leeg/fout is). */
  const phoneFromRequest = normalizeNlPhone(String(phoneParam || '').replace(/\s/g, ''));
  let effectivePhone = normalizeNlPhone(String(contact.phone || '').replace(/\s/g, ''));
  if (phoneFromRequest && /^\+31[1-9]\d{8}$/.test(phoneFromRequest)) {
    effectivePhone = phoneFromRequest;
  }

  let phoneSyncedToE164 = false;
  if (effectivePhone && /^\+31[1-9]\d{8}$/.test(effectivePhone)) {
    const raw = String(contact.phone || '').trim();
    const needsSync = !raw || !raw.startsWith('+') || normalizeNlPhone(raw) !== effectivePhone;
    if (needsSync) {
      const sync = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({ phone: effectivePhone }),
      });
      phoneSyncedToE164 = sync.ok;
      if (sync.ok) contact.phone = effectivePhone;
    }
  }

  const workType = normalizeWorkType(workTypeParam || typeParam || getField(contact, FIELD_IDS.type_onderhoud));

  // Twee concrete slots uit GHL free-slots +zelfde blok-regels als confirm-booking
  const slots = await pickConcreteInviteSlots(workType);
  if (slots.length === 0) {
    return res.status(200).json({ success: false, message: 'Geen beschikbare slots in de komende 7 werkdagen.' });
  }

  const phoneInToken = (effectivePhone && /^\+31[1-9]\d{8}$/.test(effectivePhone))
    ? effectivePhone
    : (contact.phone || '');

  // Bouw boekingstoken (bevat beide opties zodat klant kan kiezen)
  // inviteIssuedAt: unieke waarde zodat de base64-string áltijd wijzigt → GHL "custom field updated" triggert
  // opnieuw (zelfde sloten zonder dit gaven soms een identieke token = geen workflow).
  const bookingData = {
    contactId,
    name,
    phone: phoneInToken,
    email: String(contact.email || '').trim(),
    address,
    type: workType,
    inviteIssuedAt: Date.now(),
    slots: slots.map((s) => ({
      id: s.id,
      dateStr: s.dateStr,
      block: s.block,
      label: `${capitalize(s.dateLabel)} ${s.blockLabel}`,
      time: s.timeLabel,
      startMs: s.startMs,
      endMs: s.endMs,
    })),
  };
  const token = signBookingToken(bookingData);
  // Query-URL: /book/<token> geeft met cleanUrls 404 op Vercel; /book?token= laadt book.html wel.
  const bookingUrl = `${publicBaseUrl()}/book?token=${encodeURIComponent(token)}`;

  // Custom field IDs voor GHL workflow
  const FIELD_SLOT1  = 'EiSw9gZQSG4kyhPn1rtF'; // Tijdslot optie 1
  const FIELD_SLOT2  = '7Fi0c2XTjEiZve3ORFjM'; // Tijdslot optie 2
  const FIELD_TOKEN  = 'whvgJ2ILKYukDlVj81rp'; // Boekings token

  const slot1 = slots[0];
  const slot2 = slots[1];
  // Voorbeeldtekst (zelfde inhoud als template); wordt niet meer via API verstuurd.
  let message = `We hebben nog een gaatje op een van de volgende twee tijdslots:\n\n`;
  message += `*Optie 1:* ${capitalize(slot1.dateLabel)} tussen ${slot1.timeLabel}\n`;
  if (slot2) message += `*Optie 2:* ${capitalize(slot2.dateLabel)} tussen ${slot2.timeLabel}\n`;
  message += `\nKlik op de link om jouw voorkeur door te geven, dan plannen we het gelijk in:\n${bookingUrl}`;

  // Sla tijdsloten + token op — GHL-workflow stuurt het goedgekeurde WhatsApp-template
  const customFields = [
    { id: FIELD_SLOT1, field_value: `${capitalize(slot1.dateLabel)} tussen ${slot1.timeLabel}` },
    { id: FIELD_TOKEN, field_value: token },
  ];
  if (slot2) {
    customFields.push({ id: FIELD_SLOT2, field_value: `${capitalize(slot2.dateLabel)} tussen ${slot2.timeLabel}` });
  }

  const diag = {
    fieldsPut: false,
    tagRemove: false,
    tagAdd: false,
    phoneSyncedToE164,
    tokenClearPutOk: null,
  };

  // Workflow op custom field "Boekings token" (aanbevolen). Tag alleen als je workflow op tag gebruikt.
  const addBookingTag = process.env.BOOKING_ADD_TAG === 'true';

  // Altijd geldig mobiel meesturen als we het hebben (PUT zonder phone laat soms 06… staan → geen WhatsApp).
  const phoneForPut =
    effectivePhone && /^\+31[1-9]\d{8}$/.test(effectivePhone) ? effectivePhone : (contact.phone || '');

  /**
   * GHL triggert "custom field updated" vaak niet als de waarde gelijk blijft aan wat al in het veld staat.
   * Eerst token leegzetten (zoals handmatig wissen) + korte pauze, daarna volledige PUT — dan triggert de workflow weer.
   * Uitzetten: BOOKING_TOKEN_CLEAR_BEFORE_SET=false (bijv. dubbele workflow na leeg-puls).
   */
  const clearTokenFirst = process.env.BOOKING_TOKEN_CLEAR_BEFORE_SET !== 'false';
  if (clearTokenFirst) {
    const clearRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
      body: JSON.stringify({
        customFields: [{ id: FIELD_TOKEN, field_value: '' }],
        ...(phoneForPut ? { phone: phoneForPut } : {}),
      }),
    });
    diag.tokenClearPutOk = clearRes.ok;
    if (!clearRes.ok) {
      const t = await clearRes.text().catch(() => '');
      console.warn('[send-booking-invite] token clear PUT:', clearRes.status, t.slice(0, 300));
    }
    const resetMs = Math.min(Math.max(parseInt(process.env.BOOKING_TOKEN_RESET_MS || '450', 10) || 450, 0), 5000);
    if (resetMs > 0) await new Promise((r) => setTimeout(r, resetMs));
  }

  const fieldsRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({
      customFields,
      ...(phoneForPut ? { phone: phoneForPut } : {}),
    })
  });
  diag.fieldsPut = fieldsRes.ok;
  if (!fieldsRes.ok) {
    const t = await fieldsRes.text();
    console.error('[send-booking-invite] customFields PUT:', t);
  }

  if (addBookingTag) {
    const delRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({ tags: ['stuur-tijdsloten'] })
    });
    diag.tagRemove = delRes.ok;
    if (!delRes.ok) {
      const t = await delRes.text();
      console.warn('[send-booking-invite] tag DELETE:', t);
    }

    await new Promise(r => setTimeout(r, 2000));

    const addRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({ tags: ['stuur-tijdsloten'] })
    });
    diag.tagAdd = addRes.ok;
    if (!addRes.ok) {
      const t = await addRes.text();
      console.error('[send-booking-invite] tag POST:', t);
    }
  } else {
    diag.tagRemove = true;
    diag.tagAdd = true;
    console.log('[send-booking-invite] BOOKING_ADD_TAG=false — alleen custom fields (workflow op Boekings token)');
  }

  const phoneOk = /^\+31[1-9]\d{8}$/.test(effectivePhone || '');
  const workflowReady = diag.fieldsPut && (addBookingTag ? diag.tagAdd : true);

  return res.status(200).json({
    success: true,
    messageSent: false,
    whatsappViaApi: false,
    workflowReady,
    contactName: name,
    contactPhonePresent: phoneOk,
    slots: slots.map(s => ({ dateLabel: s.dateLabel, timeLabel: s.timeLabel, block: s.block })),
    bookingUrl,
    message,
    diag,
    workflowTip:
      'WhatsApp alleen via GHL-workflow (template). Standaard wist de API het Boekings token eerst en schrijft opnieuw. Uitzetten: BOOKING_TOKEN_CLEAR_BEFORE_SET=false. Pauze: BOOKING_TOKEN_RESET_MS. ' +
      'Trigger: veld Boekings token (whvgJ2ILKYukDlVj81rp) of BOOKING_ADD_TAG=true + tag stuur-tijdsloten. Contact +31-mobiel.',
  });
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
