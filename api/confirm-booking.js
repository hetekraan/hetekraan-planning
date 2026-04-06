// api/confirm-booking.js
// Verwerkt de klantenkeuze uit de boekingspagina.
// Model B (tokenSchemaVersion 2): geen timed GHL appointment — capaciteit + boeking vastgelegd op het contact (custom fields + tag).
// Legacy (v1): nog steeds POST …/appointments met start/end uit token of ankers.
// WhatsApp alleen via GHL-workflow (tag-puls).

import { logAvailability } from '../lib/availability-debug.js';
import {
  amsterdamCalendarDayBoundsMs,
  hourInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import {
  blockAllowsNewCustomerBooking,
  customerMaxForBlock,
  ghlDurationMinutesForType,
  normalizeWorkType,
} from '../lib/booking-blocks.js';
import { maxCustomerAppointmentsPerDay } from '../lib/calendar-customer-cap.js';
import {
  cachedFetchBlockedSlotsAsEvents,
  cachedFetchCalendarEventsForDay,
  cachedListConfirmedSyntheticEventsForDate,
} from '../lib/amsterdam-day-read-cache.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { fetchWithRetry } from '../lib/retry.js';
import { pulseContactTag } from '../lib/ghl-tag.js';
import { verifyBookingToken } from '../lib/session.js';
import {
  BLOCK_REASON,
  evaluateBlockOffer,
  parseBlockOfferKey,
} from '../lib/block-capacity-offers.js';
import {
  isCustomerBookingBlockedOnAmsterdamDate,
  markBlockLikeOnCalendarEvents,
  resolveAssignedUserIdForBlockedSlotQueries,
} from '../lib/ghl-calendar-blocks.js';
import {
  DAYPART_SPLIT_HOUR,
  DEFAULT_BOOK_START_AFTERNOON,
  DEFAULT_BOOK_START_MORNING,
  SLOT_LABEL_AFTERNOON_NL,
  SLOT_LABEL_MORNING_NL,
  WORK_DAY_START_HOUR,
} from '../lib/planning-work-hours.js';
import {
  createConfirmedReservation,
  hasConfirmedForContactDate,
  rollbackConfirmedReservation,
} from '../lib/block-reservation-store.js';
import { ghlCalendarIdFromEnv } from '../lib/ghl-env-ids.js';
import {
  buildCanonicalAddressWritePayload,
  GHL_ADDR_CF_IDS,
  logCanonicalAddressWrite,
  logCanonicalEmailWrite,
  readCanonicalAddressLine,
} from '../lib/ghl-contact-canonical.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

const FIELD_IDS = {
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  /** Zelfde als api/ghl.js — voor WhatsApp-template {{1}}: "23 maart tussen 13 en 17 uur" */
  tijdafspraak:        'RfKARymCOYYkufGY053T',
};

function getCf(contact, fieldId) {
  return contact?.customFields?.find((f) => f.id === fieldId)?.value || '';
}

function normalizeAddressStr(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** NL datum (kalenderdag Amsterdam) voor custom fields. */
function formatDateLongNl(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return dateStr || '';
  const utc = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Date(utc).toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Amsterdam',
  });
}

/**
 * Custom field "Tijdafspraak": het **geboekte dagdeel** (ochtend/middag-venster), niet de GHL starttijd.
 * Zo weet de monteur welk venster de klant verwacht; route-optimalisatie gebruikt de dagnummers op het dashboard.
 */
function formatGeboektTijdslotField(dateStr, block, routeStopDay) {
  const dateLong = formatDateLongNl(dateStr);
  const slot =
    block === 'morning'
      ? `ochtend ${SLOT_LABEL_MORNING_NL}`
      : `middag ${SLOT_LABEL_AFTERNOON_NL}`;
  let s = `${dateLong}. Geboekt tijdslot: ${slot}. Klant verwacht bezoek binnen dit venster.`;
  if (routeStopDay != null && routeStopDay >= 1) {
    s += ` Routevolgorde deze dag: ${routeStopDay}.`;
  }
  return s;
}

function firstValidNlMobile(...candidates) {
  for (const c of candidates) {
    const n = normalizeNlPhone(String(c ?? '').trim());
    if (/^\+31[1-9]\d{8}$/.test(n)) return n;
  }
  return '';
}

/**
 * Zelfde merged dag als suggest-slots / send-booking-invite (events + blocked-slots → markBlockLike).
 * @returns {object[]|null} null = GHL events-fetch mislukt
 */
async function loadMergedCalendarEventsForConfirmDate(dateStr, { base, locationId, calendarId, apiKey }, timingOut) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return [];
  const tCal = Date.now();
  const raw = await cachedFetchCalendarEventsForDay(dateStr, { base, locationId, calendarId, apiKey });
  if (timingOut) timingOut.ghl_calendar_fetch_ms = (timingOut.ghl_calendar_fetch_ms || 0) + (Date.now() - tCal);
  if (raw === null) return null;
  const calEv = Array.isArray(raw) ? raw : [];
  const tBlk = Date.now();
  const blockedMerged = await cachedFetchBlockedSlotsAsEvents(
    base,
    {
      locationId,
      calendarId,
      apiKey,
      assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
    },
    bounds
  );
  if (timingOut) timingOut.blocked_slots_fetch_ms = (timingOut.blocked_slots_fetch_ms || 0) + (Date.now() - tBlk);
  const merged = calEv.concat(Array.isArray(blockedMerged) ? blockedMerged : []);
  markBlockLikeOnCalendarEvents(merged);
  return merged;
}

/**
 * Contact-PUT na bevestiging. Model B: dit is de primaire persistente bron (geen timed appointment).
 * @returns {{ putPayload: object, bevestigingTemplate1: string }}
 */
function buildConfirmPutPayload({
  email,
  phoneForPut,
  address,
  type,
  desc,
  date,
  block,
  routeStopDay,
}) {
  const putPayload = { email };
  if (phoneForPut) putPayload.phone = phoneForPut;
  if (address) {
    const { address1, customFields: addrCf } = buildCanonicalAddressWritePayload(address);
    putPayload.address1 = address1;
    putPayload.customFields = [
      ...addrCf,
      { id: FIELD_IDS.type_onderhoud, field_value: type },
      { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
    ];
    logCanonicalAddressWrite('confirm-booking_buildPutPayload', {
      address1,
      straatHuisCf: addrCf.slice(0, 2).map((f) => f.field_value),
    });
  }
  const bevestigingTemplate1 = formatGeboektTijdslotField(date, block, routeStopDay);
  if (!putPayload.customFields) putPayload.customFields = [];
  putPayload.customFields = putPayload.customFields.filter((f) => f.id !== FIELD_IDS.tijdafspraak);
  putPayload.customFields.push({ id: FIELD_IDS.tijdafspraak, field_value: bevestigingTemplate1 });
  return { putPayload, bevestigingTemplate1 };
}

/** Zelfde startvelden als suggest-slots / GHL-dashboard — niet alleen `e.startTime`. */
function eventStartRawForBooking(e) {
  return (
    e?.startTime ??
    e?.start_time ??
    e?.start ??
    e?.appointmentStartTime ??
    e?.appointment?.startTime ??
    e?.calendarEvent?.startTime
  );
}

// ─── Race-condition beveiliging ───────────────────────────────────────────────
// Laag 1: in-memory lock per contactId+datum+dagdeel. Beschermt wanneer twee
//         requests op dezelfde serverless instantie tegelijk binnenkomen (dubbele klik,
//         herlaad tijdens laden, enz.).
// Laag 2: GHL-duplicate-check verderop in de handler — beschermt ook bij gelijktijdige
//         requests op verschillende instanties (cold starts, load balancing).
const _pendingBookings = new Map();
function acquireBookingLock(key) {
  const now = Date.now();
  for (const [k, t] of _pendingBookings) {
    if (now - t > 120_000) _pendingBookings.delete(k); // verlopen locks opschonen
  }
  if (_pendingBookings.has(key)) return false;
  _pendingBookings.set(key, now);
  return true;
}
function releaseBookingLock(key) {
  _pendingBookings.delete(key);
}
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const reqT0 = Date.now();
  const perf = { route: 'confirm-booking' };
  try {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Ongeldige JSON' });
    }
  }
  const { token, slotId, email: emailRaw, phone: phoneRaw, address: addressRaw } = body || {};
  if (!token || !slotId) return res.status(400).json({ error: 'token en slotId zijn verplicht' });

  const bookingData = verifyBookingToken(token);
  if (!bookingData) {
    return res.status(400).json({
      error: 'Ongeldige of verlopen boekingslink. Vraag een nieuwe link aan via onze berichtendienst.',
    });
  }

  const {
    contactId,
    name,
    phone,
    address: addressInToken,
    date: legacyDate,
    type: typeRaw,
    desc,
    slots,
    email: emailInToken,
  } = bookingData;
  const chosenSlot = slots.find(s => s.id === slotId);
  if (!chosenSlot) return res.status(400).json({ error: 'Ongeldig slot' });

  /** morning|afternoon uit slot of uit id `YYYY-MM-DD_morning` */
  function slotBlock(s) {
    const b = s?.block;
    if (b === 'morning' || b === 'afternoon') return b;
    const parts = String(s?.id || '').split('_');
    const last = parts[parts.length - 1];
    return last === 'morning' || last === 'afternoon' ? last : '';
  }

  const block = slotBlock(chosenSlot);
  if (!block) return res.status(400).json({ error: 'Ongeldig tijdblok in slot' });

  let contactSnap = null;
  const tGhlContact0 = Date.now();
  const gr = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
  });
  if (gr.ok) {
    const cd = await gr.json();
    contactSnap = cd?.contact || cd;
  }
  perf.ghl_contact_get_ms = Date.now() - tGhlContact0;

  // E-mail: formulier > token > GHL-contact
  let email = normalizeEmail(emailRaw);
  if (!isValidEmail(email)) {
    const fromToken = normalizeEmail(emailInToken);
    if (isValidEmail(fromToken)) email = fromToken;
  }
  if (!isValidEmail(email) && contactSnap) {
    const ge = normalizeEmail(contactSnap.email);
    if (isValidEmail(ge)) email = ge;
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Vul een geldig e-mailadres in (voor facturatie).' });
  }
  logCanonicalEmailWrite('confirm-booking_resolved', {
    ghlField: 'email',
    fromBody: Boolean(normalizeEmail(emailRaw) && isValidEmail(normalizeEmail(emailRaw))),
    len: email.length,
  });

  // Adres: formulier > token > GHL-contact (zelfde volgorde-idee als e-mail)
  let address = normalizeAddressStr(addressRaw);
  if (!address) address = normalizeAddressStr(addressInToken);
  if (!address && contactSnap) address = readCanonicalAddressLine(contactSnap);
  if (!address) {
    return res.status(400).json({ error: 'Vul een adres in (nodig voor de monteur en facturatie).' });
  }
  logCanonicalAddressWrite('confirm-booking_resolved', {
    len: address.length,
    preview: address.slice(0, 100),
    fromBody: Boolean(normalizeAddressStr(addressRaw)),
    ghlFields: ['address1', 'customFields.straatnaam', 'customFields.huisnummer', 'customFields.postcode', 'customFields.woonplaats'],
  });

  /** V2 slot-id is `YYYY-MM-DD_morning|afternoon` — die datum is canoniek (voorkomt afwijkende dateStr in token). */
  const slotIdParsed = parseBlockOfferKey(slotId);
  const date = slotIdParsed?.dateStr || chosenSlot.dateStr || legacyDate;
  if (!date) return res.status(400).json({ error: 'Geen datum in slot' });

  const tDayBlk0 = Date.now();
  const dayBlkConfirm = await isCustomerBookingBlockedOnAmsterdamDate(
    GHL_BASE,
    {
      locationId: GHL_LOCATION_ID,
      calendarId: ghlCalendarIdFromEnv(),
      apiKey: GHL_API_KEY,
      assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
    },
    date
  );
  perf.day_blocked_check_ms = Date.now() - tDayBlk0;
  if (dayBlkConfirm) {
    logAvailability('confirm_booking_rejected', {
      flow: 'confirm-booking',
      outcome: 'excluded',
      why: 'customer_day_blocked',
      dateStr: date,
      timeZone: 'Europe/Amsterdam',
      hasContactId: !!contactId,
    });
    return res.status(409).json({
      error: 'Deze dag is niet beschikbaar voor online boeken (agenda geblokkeerd). Kies een andere dag of neem contact op.',
      code: 'DAY_BLOCKED',
    });
  }

  // Laag 1: in-memory lock — voorkomt duplicaten bij gelijktijdige requests op dezelfde instantie.
  const lockKey = `${contactId}:${date}:${block}`;
  if (!acquireBookingLock(lockKey)) {
    return res.status(409).json({
      error: 'Je boeking wordt al verwerkt. Wacht even en ververs de pagina als er niets is veranderd.',
      code: 'BOOKING_IN_PROGRESS',
    });
  }

  const type = normalizeWorkType(typeRaw || getCf(contactSnap, FIELD_IDS.type_onderhoud));
  const isV2 = Number(bookingData.tokenSchemaVersion) === 2;
  const phoneForPut = firstValidNlMobile(phoneRaw, phone, contactSnap?.phone);

  // TEMP DEBUG — verwijder na productie-verificatie (welke confirm-branch draait er?)
  console.log('[confirm-booking DEBUG] tokenSchemaVersion=', bookingData.tokenSchemaVersion ?? '(missing)');
  console.log('[confirm-booking DEBUG] slotId=', slotId);
  console.log('[confirm-booking DEBUG] chosenSlot=', JSON.stringify(chosenSlot));
  console.log('[confirm-booking DEBUG] isV2_B1=', isV2);

  // ─── Model B1 (tokenSchemaVersion 2): block-capacity check + contact only; geen GHL appointment ──
  if (isV2) {
    console.log('[confirm-booking DEBUG] path=v2_B1_entered');
    console.log('[confirm-booking DEBUG] v2 date_trace', {
      slotId,
      dateFromSlotId: slotIdParsed?.dateStr ?? null,
      chosenSlotDateStr: chosenSlot.dateStr ?? null,
      resolvedDate: date,
    });
    console.log('[confirm-booking DEBUG] v2 before_duplicate_check_redis', { contactId, date });
    let alreadyReservedRedis;
    const tRedisDup0 = Date.now();
    try {
      alreadyReservedRedis = await hasConfirmedForContactDate(contactId, date);
    } catch (dupCheckErr) {
      perf.redis_has_confirmed_ms = Date.now() - tRedisDup0;
      console.error(
        '[confirm-booking DEBUG] v2 hasConfirmedForContactDate threw:',
        dupCheckErr?.message || dupCheckErr,
        dupCheckErr?.stack
      );
      releaseBookingLock(lockKey);
      return res.status(503).json({
        error:
          'Reserveringsservice is tijdelijk niet beschikbaar. Probeer het over een paar minuten opnieuw of neem contact op.',
        code: 'RESERVATION_STORE_ERROR',
      });
    }
    perf.redis_has_confirmed_ms = Date.now() - tRedisDup0;
    if (alreadyReservedRedis) {
      releaseBookingLock(lockKey);
      console.log('[confirm-booking] Duplicate (B1 reservering):', contactId, date);
      return res.status(200).json({
        success: true,
        tokenSchemaVersion: 2,
        bookingModel: 'B',
        appointmentId: null,
        alreadyBooked: true,
        message: 'Er staat al een afspraak voor je ingepland op deze dag.',
      });
    }
    console.log('[confirm-booking DEBUG] v2 after_duplicate_check_redis_ok');

    const mergeTiming = {};
    const merged = await loadMergedCalendarEventsForConfirmDate(date, {
      base: GHL_BASE,
      locationId: GHL_LOCATION_ID,
      calendarId: ghlCalendarIdFromEnv(),
      apiKey: GHL_API_KEY,
    }, mergeTiming);
    perf.ghl_calendar_fetch_ms = mergeTiming.ghl_calendar_fetch_ms || 0;
    perf.blocked_slots_fetch_ms = mergeTiming.blocked_slots_fetch_ms || 0;
    if (merged === null) {
      releaseBookingLock(lockKey);
      return res.status(503).json({
        error:
          'We konden de agenda nu niet uitlezen in GHL. Probeer het over een paar minuten opnieuw of neem contact op.',
        code: 'AGENDA_CHECK_FAILED',
      });
    }

    let synthetics = [];
    const tRedisSyn0 = Date.now();
    try {
      synthetics = await cachedListConfirmedSyntheticEventsForDate(date);
    } catch (synErr) {
      console.error('[confirm-booking] listConfirmedSyntheticEventsForDate:', synErr?.message || synErr);
    }
    perf.redis_synthetic_read_ms = Date.now() - tRedisSyn0;
    const eventsForCapacity = merged.concat(Array.isArray(synthetics) ? synthetics : []);
    console.log('[confirm-booking DEBUG] v2 capacity_events', {
      mergedLen: merged.length,
      syntheticLen: Array.isArray(synthetics) ? synthetics.length : 0,
      totalLen: eventsForCapacity.length,
    });

    const customerEventsV2 = merged.filter((e) => !e._hkGhlBlockSlot);

    const alreadyBookedV2 = customerEventsV2.find((e) => {
      const cid = e.contactId || e.contact_id || e.contact?.id;
      return cid && String(cid) === String(contactId);
    });
    if (alreadyBookedV2) {
      releaseBookingLock(lockKey);
      const existingId =
        alreadyBookedV2.id || alreadyBookedV2.eventId || alreadyBookedV2.appointmentId || null;
      console.log('[confirm-booking] Duplicate boeking (B1) onderschept:', contactId, date);
      return res.status(200).json({
        success: true,
        tokenSchemaVersion: 2,
        bookingModel: 'B',
        appointmentId: existingId,
        alreadyBooked: true,
        message: 'Er staat al een afspraak voor je ingepland op deze dag.',
      });
    }

    console.log('[confirm-booking DEBUG] v2 before_evaluateBlockOffer', { date, block, type });
    const tEval0 = Date.now();
    const evaluation = evaluateBlockOffer({
      dateStr: date,
      block,
      workType: type,
      events: eventsForCapacity,
      dayBlocked: false,
    });
    perf.evaluate_block_offer_ms = Date.now() - tEval0;
    console.log('[confirm-booking DEBUG] v2 after_evaluateBlockOffer', {
      eligible: evaluation.eligible,
      reason: evaluation.reason,
    });
    if (!evaluation.eligible) {
      releaseBookingLock(lockKey);
      const reason = evaluation.reason;
      if (reason === BLOCK_REASON.DAY_CAP) {
        const maxD = evaluation.state.maxPerDay;
        return res.status(409).json({
          error:
            `Er staan al ${maxD} klant-afspraken op deze dag in de agenda. Online boeken is niet meer mogelijk; neem contact op of kies een andere dag. Handmatig kun je in GHL nog een extra afspraak toevoegen.`,
          code: 'DAY_CAP_REACHED',
          dayCount: evaluation.state.dayCustomerCount,
          maxPerDay: maxD,
        });
      }
      if (reason === BLOCK_REASON.BLOCK_CAPACITY) {
        const maxB = customerMaxForBlock(block);
        const blokNaam =
          block === 'morning'
            ? `ochtend (${SLOT_LABEL_MORNING_NL})`
            : `middag (${SLOT_LABEL_AFTERNOON_NL})`;
        return res.status(409).json({
          error: `Dit tijdslot past niet meer: in de ${blokNaam} zitten al ${maxB} klant-afspraken of er is onvoldoende geplande tijd over voor dit werk. Kies een andere optie of bel ons.`,
          code: 'BLOCK_FULL',
          maxPerBlock: maxB,
        });
      }
      if (reason === BLOCK_REASON.INVALID_INPUT) {
        releaseBookingLock(lockKey);
        return res.status(400).json({ error: 'Ongeldige boekingskeuze. Vraag een nieuwe link aan.' });
      }
      return res.status(409).json({
        error: 'Deze optie is niet meer beschikbaar. Kies een andere dag of neem contact op.',
        code: 'BLOCK_FULL',
      });
    }

    console.log('[confirm-booking DEBUG] v2 before_reservation_create');
    let resv;
    const tResv0 = Date.now();
    try {
      resv = await createConfirmedReservation({
        contactId,
        dateStr: date,
        block,
        workType: type,
      });
    } catch (e) {
      perf.redis_reservation_write_ms = Date.now() - tResv0;
      console.error('[confirm-booking DEBUG] v2 reservation_create threw:', e?.message || e, e?.stack);
      console.error('[confirm-booking] reservation write:', e?.message || e);
      releaseBookingLock(lockKey);
      return res.status(503).json({
        error:
          'Reserveringsservice is tijdelijk niet beschikbaar. Probeer het over een paar minuten opnieuw of neem contact op.',
        code: 'RESERVATION_STORE_ERROR',
      });
    }
    perf.redis_reservation_write_ms = Date.now() - tResv0;
    if (!resv.ok) {
      console.log('[confirm-booking DEBUG] v2 after_reservation_create_not_ok', resv);
      if (resv.code === 'DUPLICATE_CONTACT_DATE') {
        releaseBookingLock(lockKey);
        console.log('[confirm-booking] Duplicate (B1 SET NX):', contactId, date);
        return res.status(200).json({
          success: true,
          tokenSchemaVersion: 2,
          bookingModel: 'B',
          appointmentId: null,
          alreadyBooked: true,
          message: 'Er staat al een afspraak voor je ingepland op deze dag.',
        });
      }
      if (resv.code === 'STORE_UNAVAILABLE') {
        releaseBookingLock(lockKey);
        return res.status(503).json({
          error:
            'Reserveringsservice is tijdelijk niet beschikbaar. Probeer het over een paar minuten opnieuw of neem contact op.',
          code: 'RESERVATION_STORE_UNAVAILABLE',
        });
      }
      releaseBookingLock(lockKey);
      return res.status(400).json({ error: 'Ongeldige boekingsgegevens. Vraag een nieuwe link aan.' });
    }
    console.log('[confirm-booking DEBUG] v2 after_reservation_create_ok', {
      reservationId: resv.reservation?.id,
      reservationDateStr: resv.reservation?.dateStr,
    });

    const customerEventsForRoute = eventsForCapacity.filter((e) => !e._hkGhlBlockSlot);
    const routeStopDayV2 = Math.min(customerEventsForRoute.length + 1, 7);
    const { putPayload: putPayloadB1, bevestigingTemplate1: bevestigingB1 } = buildConfirmPutPayload({
      email,
      phoneForPut,
      address,
      type,
      desc,
      date,
      block,
      routeStopDay: routeStopDayV2,
    });
    console.log('[confirm-booking DEBUG] v2 tijdafspraak_field', { value: bevestigingB1 });

    console.log('[confirm-booking DEBUG] v2 before_ghl_contact_put', {
      contactId,
      putKeys: Object.keys(putPayloadB1),
      customFieldsLen: putPayloadB1.customFields?.length ?? 0,
    });
    const tPutB10 = Date.now();
    const putResB1 = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
      body: JSON.stringify(putPayloadB1),
    });
    perf.ghl_contact_put_ms = Date.now() - tPutB10;
    if (!putResB1.ok) {
      const errTxt = await putResB1.text().catch(() => '');
      console.error('[confirm-booking DEBUG] v2 after_ghl_contact_put_failed', {
        status: putResB1.status,
        body: (errTxt || '').slice(0, 1200),
        attemptedAddress1: putPayloadB1.address1,
        attemptedStraatCf: putPayloadB1.customFields?.find((f) => f.id === GHL_ADDR_CF_IDS.straatnaam)?.field_value,
      });
      console.error('[confirm-booking] contact PUT (B1):', putResB1.status, errTxt);
      try {
        await rollbackConfirmedReservation(resv.reservation);
      } catch (rbErr) {
        console.error('[confirm-booking] rollback na PUT-fout mislukt:', rbErr?.message || rbErr);
      }
      releaseBookingLock(lockKey);
      return res.status(502).json({ error: 'Kon gegevens niet opslaan in GHL. Probeer het later opnieuw.' });
    }
    console.log('[confirm-booking DEBUG] v2 after_ghl_contact_put_ok', { status: putResB1.status });

    releaseBookingLock(lockKey);

    logAvailability('confirm_booking_b1', {
      flow: 'confirm-booking',
      bookingModel: 'B',
      dateStr: date,
      block,
      contactId,
      /** Operationele bron: GHL-contact custom fields (o.a. tijdafspraak), geen agenda-item. */
      sourceOfTruth: 'ghl_contact_custom_fields',
    });

    const dateFormattedB1 = new Date(`${date}T12:00:00+01:00`).toLocaleDateString('nl-NL', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Amsterdam',
    });

    const confirmTagB1 = process.env.BOOKING_CONFIRM_TAG === undefined || process.env.BOOKING_CONFIRM_TAG === ''
      ? 'boeking-bevestigd'
      : process.env.BOOKING_CONFIRM_TAG;
    const tagDisabledB1 = confirmTagB1 === 'false' || confirmTagB1 === 'none';
    const tagFallbackB1 = process.env.BOOKING_CONFIRM_TAG_FALLBACK !== 'false' && !tagDisabledB1;

    const delayMsB1 = Math.min(Math.max(parseInt(process.env.BOOKING_CONFIRM_DELAY_MS || '600', 10) || 600, 0), 5000);
    const tTagB10 = Date.now();
    if (delayMsB1 > 0) {
      await new Promise((r) => setTimeout(r, delayMsB1));
    }

    let workflowTriggeredB1 = false;
    if (tagFallbackB1) {
      workflowTriggeredB1 = await pulseContactTag(contactId, confirmTagB1, '[confirm-booking] B1');
      if (workflowTriggeredB1) {
        console.log('[confirm-booking] Tag-puls voor workflow (B1):', confirmTagB1);
      } else {
        console.error('[confirm-booking] Tag-puls mislukt (B1):', confirmTagB1);
      }
    }
    perf.tag_delay_and_pulse_ms = Date.now() - tTagB10;

    const tMapB10 = Date.now();
    const outB1 = {
      success: true,
      tokenSchemaVersion: 2,
      bookingModel: 'B',
      blockCapacityOnly: true,
      appointmentId: null,
      contactId,
      slot: chosenSlot,
      date: dateFormattedB1,
      messageSent: false,
      whatsappViaApi: false,
      workflowTriggered: workflowTriggeredB1,
      phoneSaved: Boolean(phoneForPut),
      routeStopDay: routeStopDayV2,
      tijdafspraakField: bevestigingB1,
    };

    if (process.env.BOOKING_CONFIRM_DEBUG === 'true') {
      outB1.diag = { confirmTag: confirmTagB1, tagFallback: tagFallbackB1, tagPulseOk: workflowTriggeredB1 };
    } else if (tagFallbackB1 && !workflowTriggeredB1) {
      outB1.hint =
        'Tag-puls mislukt. Controleer GHL API-key/scopes en of de tag exact “' +
        confirmTagB1 +
        '” heet. WhatsApp gaat alleen via je workflow op die tag.';
    }

    console.log('[confirm-booking DEBUG] v2 before_success_response');
    perf.map_response_ms = Date.now() - tMapB10;
    perf.branch = 'v2_B1';
    return res.status(200).json(outB1);
  }

  // ─── Legacy (v1): zelfde checks op ruwe dag-events + timed GHL appointment ─────────────────────
  console.log('[confirm-booking DEBUG] path=legacy_v1_timed_appointment_entered');
  perf.branch = 'v1_timed_appt';

  const tV1Cal0 = Date.now();
  const eventsForDay = await cachedFetchCalendarEventsForDay(date, {
    base: GHL_BASE,
    locationId: GHL_LOCATION_ID,
    calendarId: ghlCalendarIdFromEnv(),
    apiKey: GHL_API_KEY,
  });
  perf.v1_ghl_calendar_fetch_ms = Date.now() - tV1Cal0;
  if (!eventsForDay) {
    releaseBookingLock(lockKey);
    return res.status(503).json({
      error:
        'We konden de agenda nu niet uitlezen in GHL. Probeer het over een paar minuten opnieuw of neem contact op.',
      code: 'AGENDA_CHECK_FAILED',
    });
  }

  markBlockLikeOnCalendarEvents(eventsForDay);
  const customerEvents = eventsForDay.filter((e) => !e._hkGhlBlockSlot);

  const dayCap = maxCustomerAppointmentsPerDay();
  const dayCount = customerEvents.length;
  if (dayCount >= dayCap) {
    releaseBookingLock(lockKey);
    return res.status(409).json({
      error:
        `Er staan al ${dayCap} klant-afspraken op deze dag in de agenda. Online boeken is niet meer mogelijk; neem contact op of kies een andere dag. Handmatig kun je in GHL nog een extra afspraak toevoegen.`,
      code: 'DAY_CAP_REACHED',
      dayCount,
      maxPerDay: dayCap,
    });
  }

  const inMorning = (e) => {
    const raw = eventStartRawForBooking(e);
    if (raw == null) return false;
    return hourInAmsterdam(raw) < DAYPART_SPLIT_HOUR;
  };
  const inAfternoon = (e) => {
    const raw = eventStartRawForBooking(e);
    if (raw == null) return false;
    return hourInAmsterdam(raw) >= DAYPART_SPLIT_HOUR;
  };
  const blockEvents = customerEvents.filter((e) => (block === 'morning' ? inMorning(e) : inAfternoon(e)));
  if (!blockAllowsNewCustomerBooking(block, blockEvents, type)) {
    const maxB = customerMaxForBlock(block);
    const blokNaam =
      block === 'morning'
        ? `ochtend (${SLOT_LABEL_MORNING_NL})`
        : `middag (${SLOT_LABEL_AFTERNOON_NL})`;
    releaseBookingLock(lockKey);
    return res.status(409).json({
      error: `Dit tijdslot past niet meer: in de ${blokNaam} zitten al ${maxB} klant-afspraken of er is onvoldoende geplande tijd over voor dit werk. Kies een andere optie of bel ons.`,
      code: 'BLOCK_FULL',
      maxPerBlock: maxB,
    });
  }

  // Laag 2: GHL duplicate-check — beschermt bij concurrent requests op verschillende instances.
  const alreadyBooked = customerEvents.find((e) => {
    const cid = e.contactId || e.contact_id || e.contact?.id;
    return cid && String(cid) === String(contactId);
  });
  if (alreadyBooked) {
    releaseBookingLock(lockKey);
    const existingId =
      alreadyBooked.id || alreadyBooked.eventId || alreadyBooked.appointmentId || null;
    console.log('[confirm-booking] Duplicate boeking onderschept via GHL-check:', contactId, date);
    return res.status(200).json({
      success: true,
      appointmentId: existingId,
      alreadyBooked: true,
      message: 'Er staat al een afspraak voor je ingepland op deze dag.',
    });
  }

  const durationMin = ghlDurationMinutesForType(type);

  /** Legacy v1: exacte GHL free-slot in token; anders suggestedTime / DEFAULT_BOOK_START_* */
  let bookStartMs;
  let bookEndMs;
  const tokenStart = chosenSlot.startMs;
  const tokenEnd = chosenSlot.endMs;
  if (Number.isFinite(tokenStart) && typeof tokenStart === 'number' && tokenStart > 1e11) {
    bookStartMs = tokenStart;
    if (Number.isFinite(tokenEnd) && typeof tokenEnd === 'number' && tokenEnd > bookStartMs) {
      bookEndMs = tokenEnd;
    } else {
      bookEndMs = bookStartMs + durationMin * 60 * 1000;
    }
  } else {
    const timeMap = { morning: DEFAULT_BOOK_START_MORNING, afternoon: DEFAULT_BOOK_START_AFTERNOON };
    const startTimeStr = chosenSlot.suggestedTime || timeMap[block] || DEFAULT_BOOK_START_MORNING;
    const timeParts = startTimeStr.split(':').map(Number);
    const hours = timeParts[0] ?? WORK_DAY_START_HOUR;
    const minutes = Number.isFinite(timeParts[1]) ? timeParts[1] : 0;
    const startAnchor = amsterdamWallTimeToDate(date, hours, minutes);
    bookStartMs = startAnchor ? startAnchor.getTime() : NaN;
    bookEndMs = bookStartMs + durationMin * 60 * 1000;
  }

  if (!Number.isFinite(bookStartMs)) {
    releaseBookingLock(lockKey);
    return res.status(400).json({ error: 'Ongeldige datum of tijd in het tijdslot.' });
  }

  const appointmentSpanMs = Math.max(bookEndMs - bookStartMs, durationMin * 60 * 1000);

  const routeStopDay = Math.min(customerEvents.length + 1, 7);
  const { putPayload, bevestigingTemplate1 } = buildConfirmPutPayload({
    email,
    phoneForPut,
    address,
    type,
    desc,
    date,
    block,
    routeStopDay,
  });

  // Zelfde API-versie als send-booking-invite (sommige PUTs mergen anders op 2021-07-28).
  const tV1Put0 = Date.now();
  const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
    body: JSON.stringify(putPayload),
  });
  perf.v1_ghl_contact_put_ms = Date.now() - tV1Put0;
  if (!putRes.ok) {
    const errTxt = await putRes.text().catch(() => '');
    console.error('[confirm-booking] contact PUT (v1):', putRes.status, errTxt);
    console.error('[confirm-booking DEBUG] v1 contact_put_failed address snapshot', {
      attemptedAddress1: putPayload.address1,
      attemptedStraatCf: putPayload.customFields?.find((f) => f.id === GHL_ADDR_CF_IDS.straatnaam)?.field_value,
    });
    releaseBookingLock(lockKey);
    return res.status(502).json({ error: 'Kon gegevens niet opslaan in GHL. Probeer het later opnieuw.' });
  }

  function pickAppointmentId(data) {
    if (!data || typeof data !== 'object') return null;
    return (
      data.id ||
      data._id ||
      data.appointmentId ||
      data.appointment?.id ||
      data.appointment?._id ||
      data.event?.id ||
      data.event?._id ||
      data.data?.id ||
      data.data?._id ||
      data.result?.id ||
      data.result?._id ||
      null
    );
  }

  async function resolveAssignedUserId() {
    const envId = (process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID || '').trim();
    if (envId) return envId;
    const urls = [
      `${GHL_BASE}/calendars/${encodeURIComponent(ghlCalendarIdFromEnv())}?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`,
      `${GHL_BASE}/locations/${encodeURIComponent(GHL_LOCATION_ID)}/calendars/${encodeURIComponent(ghlCalendarIdFromEnv())}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
        });
        if (!r.ok) continue;
        const j = await r.json();
        const cal = j?.calendar || j?.data || j;
        const uid =
          cal?.userId ||
          cal?.primaryUserId ||
          cal?.assignedUserId ||
          cal?.teamMembers?.[0]?.userId ||
          cal?.teamMembers?.[0]?.id ||
          (Array.isArray(cal?.calendarUserIds) ? cal.calendarUserIds[0] : null) ||
          (Array.isArray(cal?.memberIds) ? cal.memberIds[0] : null);
        if (uid) return String(uid);
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  const tResolveUser0 = Date.now();
  const assignedUserId = await resolveAssignedUserId();
  perf.v1_resolve_calendar_user_ms = Date.now() - tResolveUser0;

  function summarizeGhlError(raw) {
    if (raw == null || typeof raw !== 'string') return '';
    const t = raw.trim().slice(0, 2000);
    if (!t) return '';
    try {
      const j = JSON.parse(t);
      const parts = [
        j.message,
        j.error,
        j.msg,
        j.meta && typeof j.meta === 'object' && j.meta.message,
        Array.isArray(j.errors) && j.errors[0] && j.errors[0].message,
      ].filter((x) => typeof x === 'string' && x.trim());
      if (parts.length) return clipGhlDetail(parts[0].trim(), 300);
    } catch {
      /* plain text */
    }
    return clipGhlDetail(t.replace(/\s+/g, ' '), 300);
  }

  function clipGhlDetail(s, max) {
    if (s.length <= max) return s;
    return `${s.slice(0, max - 1)}…`;
  }

  /** includeAssignedUser: false = geen assignedUserId (sommige kalenders falen op auto/user-id). */
  function buildApptBody(tryStart, tryEnd, extra, includeAssignedUser) {
    const body = {
      calendarId: ghlCalendarIdFromEnv(),
      locationId: GHL_LOCATION_ID,
      contactId,
      startTime: tryStart.toISOString(),
      endTime: tryEnd.toISOString(),
      title: `${name} – ${type}`,
      address: address || '',
      ignoreDateRange: true,
      ...extra,
    };
    if (includeAssignedUser && assignedUserId) body.assignedUserId = assignedUserId;
    return body;
  }

  const offsets = [0, -5, 5, -10, 10, -15, 15, -30, 30];
  let appointmentId = null;
  let lastError = null;
  let lastStatus = 0;

  function isSlotRelatedError(errText) {
    const lower = String(errText || '').toLowerCase();
    return (
      lower.includes('slot') ||
      lower.includes('available') ||
      lower.includes('conflict') ||
      lower.includes('bezet') ||
      lower.includes('busy') ||
      lower.includes('overlap')
    );
  }

  const attempts = [
    { version: '2021-07-28', extra: { appointmentStatus: 'confirmed', ignoreLimits: true } },
    { version: '2021-04-15', extra: { appointmentStatus: 'confirmed', ignoreLimits: true } },
    { version: '2021-04-15', extra: {} },
  ];

  const userPasses = assignedUserId ? [true, false] : [false];

  console.log('[confirm-booking DEBUG] agenda_POST_attempt_begin → POST …/calendars/events/appointments');

  const tV1Appt0 = Date.now();
  outer: for (const includeAssignedUser of userPasses) {
    for (const { version, extra } of attempts) {
      for (const offsetMin of offsets) {
        const tryStartMs = bookStartMs + offsetMin * 60 * 1000;
        const tryStart = new Date(tryStartMs);
        const tryEnd = new Date(tryStartMs + appointmentSpanMs);

        // Gebruik plain fetch (geen retry): een retry na 5xx zou een tweede GHL-afspraak aanmaken.
        const apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: version,
          },
          body: JSON.stringify(buildApptBody(tryStart, tryEnd, extra, includeAssignedUser)),
        });

        lastStatus = apptRes.status;
        const errText = await apptRes.text().catch(() => '');
        let apptData = null;
        if (apptRes.ok) {
          try {
            apptData = errText ? JSON.parse(errText) : {};
          } catch {
            apptData = {};
          }
          appointmentId = pickAppointmentId(apptData);
          if (!appointmentId) {
            // GHL keerde 200 OK terug maar zonder id — de afspraak IS aangemaakt.
            // Niet opnieuw proberen: dat maakt een tweede dubbele afspraak in GHL.
            console.warn('[confirm-booking] GHL 200 maar geen id in response; stoppen om duplicaat te voorkomen', (errText || '').slice(0, 300));
          }
          // 200 OK = afspraak aangemaakt → altijd stoppen ongeacht of we een id hebben
          break outer;
        }

        lastError = errText;
        if (!isSlotRelatedError(errText)) break;
      }
    }
  }
  perf.v1_ghl_appointment_post_sum_ms = Date.now() - tV1Appt0;

  // Lock vrijgeven: de afspraak is aangemaakt (of mislukt) — verdere stappen (tag, response) hebben het slot niet meer nodig.
  releaseBookingLock(lockKey);

  if (!appointmentId) {
    console.error('[confirm-booking] Agenda-POST mislukt:', lastStatus, (lastError || '').slice(0, 800));
    const ghlSummary = summarizeGhlError(lastError);
    const showFull = process.env.BOOKING_CONFIRM_PUBLIC_ERROR === 'true' || process.env.BOOKING_CONFIRM_DEBUG === 'true';
    return res.status(500).json({
      error: 'Kon geen afspraak aanmaken in de agenda',
      ghlStatus: lastStatus,
      ghlSummary: ghlSummary || undefined,
      ...(showFull ? { ghlBody: (lastError || '').slice(0, 800) } : {}),
      ...(ghlSummary
        ? {}
        : {
            hint:
              'Controleer GHL API-scopes (o.a. calendars/events.write), GHL_CALENDAR_ID, en zet eventueel GHL_APPOINTMENT_ASSIGNED_USER_ID.',
          }),
    });
  }

  const dateFormatted = new Date(`${date}T12:00:00+01:00`).toLocaleDateString('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const confirmTag = process.env.BOOKING_CONFIRM_TAG === undefined || process.env.BOOKING_CONFIRM_TAG === ''
    ? 'boeking-bevestigd'
    : process.env.BOOKING_CONFIRM_TAG;
  const tagDisabled = confirmTag === 'false' || confirmTag === 'none';
  const tagFallback = process.env.BOOKING_CONFIRM_TAG_FALLBACK !== 'false' && !tagDisabled;

  const tV1Tag0 = Date.now();
  const delayMs = Math.min(Math.max(parseInt(process.env.BOOKING_CONFIRM_DELAY_MS || '600', 10) || 600, 0), 5000);
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  let workflowTriggered = false;
  if (tagFallback) {
    workflowTriggered = await pulseContactTag(contactId, confirmTag, '[confirm-booking]');
    if (workflowTriggered) {
      console.log('[confirm-booking] Tag-puls voor workflow:', confirmTag);
    } else {
      console.error('[confirm-booking] Tag-puls mislukt:', confirmTag);
    }
  }
  perf.v1_tag_delay_pulse_ms = Date.now() - tV1Tag0;

  const tOutV10 = Date.now();
  const out = {
    success: true,
    appointmentId,
    contactId,
    slot: chosenSlot,
    date: dateFormatted,
    messageSent: false,
    whatsappViaApi: false,
    workflowTriggered,
    phoneSaved: Boolean(phoneForPut),
    routeStopDay: routeStopDay ?? undefined,
    tijdafspraakField: bevestigingTemplate1,
  };

  if (process.env.BOOKING_CONFIRM_DEBUG === 'true') {
    out.diag = { confirmTag, tagFallback, tagPulseOk: workflowTriggered };
  } else if (tagFallback && !workflowTriggered) {
    out.hint =
      'Tag-puls mislukt. Controleer GHL API-key/scopes en of de tag exact “' +
      confirmTag +
        '” heet. WhatsApp gaat alleen via je workflow op die tag.';
  }

  perf.map_response_ms = Date.now() - tOutV10;
  return res.status(200).json(out);
  } finally {
    perf.total_ms = Date.now() - reqT0;
    console.log('[timing confirm-booking]', JSON.stringify(perf));
  }
}

function normalizeEmail(v) {
  return String(v ?? '').trim().toLowerCase();
}

function isValidEmail(s) {
  if (!s || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s);
}
