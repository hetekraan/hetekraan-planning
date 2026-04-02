// api/confirm-booking.js
// Verwerkt de klantenkeuze uit de boekingspagina.
// Maakt de GHL-afspraak aan; WhatsApp alleen via GHL-workflow (tag-puls).

import { hourInAmsterdam } from '../lib/amsterdam-calendar-day.js';
import {
  blockAllowsNewCustomerBooking,
  customerMaxForBlock,
  ghlDurationMinutesForType,
  normalizeWorkType,
} from '../lib/booking-blocks.js';
import { fetchCalendarEventsForDay, maxCustomerAppointmentsPerDay } from '../lib/calendar-customer-cap.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { fetchWithRetry } from '../lib/retry.js';
import { pulseContactTag } from '../lib/ghl-tag.js';
import { verifyBookingToken } from '../lib/session.js';
import {
  dayHasCustomerBlockingOverlap,
  HK_DEFAULT_BLOCK_SLOT_USER_ID,
  markBlockLikeOnCalendarEvents,
} from '../lib/ghl-calendar-blocks.js';
import {
  DAYPART_SPLIT_HOUR,
  DEFAULT_BOOK_START_AFTERNOON,
  DEFAULT_BOOK_START_MORNING,
  SLOT_LABEL_AFTERNOON_NL,
  SLOT_LABEL_MORNING_NL,
  WORK_DAY_START_HOUR,
} from '../lib/planning-work-hours.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  /** Zelfde als api/ghl.js — voor WhatsApp-template {{1}}: "23 maart tussen 13 en 17 uur" */
  tijdafspraak:        'RfKARymCOYYkufGY053T',
};

function getCf(contact, fieldId) {
  return contact?.customFields?.find((f) => f.id === fieldId)?.value || '';
}

function stripGhlEnvId(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function effectiveBlockSlotUserId() {
  return (
    stripGhlEnvId(process.env.GHL_BLOCK_SLOT_USER_ID) ||
    stripGhlEnvId(process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID) ||
    HK_DEFAULT_BLOCK_SLOT_USER_ID
  );
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

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Ongeldige JSON' });
    }
  }
  const { token, slotId, email: emailRaw, phone: phoneRaw } = body || {};
  if (!token || !slotId) return res.status(400).json({ error: 'token en slotId zijn verplicht' });

  const bookingData = verifyBookingToken(token);
  if (!bookingData) {
    return res.status(400).json({
      error: 'Ongeldige of verlopen boekingslink. Vraag een nieuwe link aan via onze berichtendienst.',
    });
  }

  const { contactId, name, phone, address, date: legacyDate, type: typeRaw, desc, slots, email: emailInToken } = bookingData;
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
  const gr = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
  });
  if (gr.ok) {
    const cd = await gr.json();
    contactSnap = cd?.contact || cd;
  }

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

  const date = chosenSlot.dateStr || legacyDate;
  if (!date) return res.status(400).json({ error: 'Geen datum in slot' });

  if (
    await dayHasCustomerBlockingOverlap(
      GHL_BASE,
      {
        locationId: GHL_LOCATION_ID,
        calendarId: GHL_CALENDAR_ID,
        apiKey: GHL_API_KEY,
        assignedUserId: effectiveBlockSlotUserId(),
      },
      date
    )
  ) {
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

  const eventsForDay = await fetchCalendarEventsForDay(date, {
    base: GHL_BASE,
    locationId: GHL_LOCATION_ID,
    calendarId: GHL_CALENDAR_ID,
    apiKey: GHL_API_KEY,
  });
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

  const timeMap = { morning: DEFAULT_BOOK_START_MORNING, afternoon: DEFAULT_BOOK_START_AFTERNOON };
  const startTimeStr = chosenSlot.suggestedTime || timeMap[block] || DEFAULT_BOOK_START_MORNING;
  const timeParts = startTimeStr.split(':').map(Number);
  const hours = timeParts[0] ?? WORK_DAY_START_HOUR;
  const minutes = Number.isFinite(timeParts[1]) ? timeParts[1] : 0;
  const durationMin = ghlDurationMinutesForType(type);

  const startAnchor = amsterdamWallTimeToDate(date, hours, minutes);
  const startMs = startAnchor ? startAnchor.getTime() : NaN;
  if (!Number.isFinite(startMs)) {
    releaseBookingLock(lockKey);
    return res.status(400).json({ error: 'Ongeldige datum of tijd in het tijdslot.' });
  }

  const phoneForPut = firstValidNlMobile(phoneRaw, phone, contactSnap?.phone);
  const putPayload = { email };
  if (phoneForPut) putPayload.phone = phoneForPut;

  if (address) {
    const parts = address.split(' ');
    const huisnummer = parts.find(p => /^\d/.test(p)) || '';
    const straatnaam = parts.slice(0, parts.findIndex(p => /^\d/.test(p))).join(' ') || address;
    putPayload.customFields = [
      { id: FIELD_IDS.straatnaam, field_value: straatnaam },
      { id: FIELD_IDS.huisnummer, field_value: huisnummer },
      { id: FIELD_IDS.type_onderhoud, field_value: type },
      { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
    ];
  }

  const routeStopDay = Math.min(customerEvents.length + 1, 7);
  const bevestigingTemplate1 = formatGeboektTijdslotField(date, block, routeStopDay);
  if (!putPayload.customFields) putPayload.customFields = [];
  putPayload.customFields = putPayload.customFields.filter((f) => f.id !== FIELD_IDS.tijdafspraak);
  putPayload.customFields.push({ id: FIELD_IDS.tijdafspraak, field_value: bevestigingTemplate1 });

  // Zelfde API-versie als send-booking-invite (sommige PUTs mergen anders op 2021-07-28).
  const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
    body: JSON.stringify(putPayload),
  });
  if (!putRes.ok) {
    const errTxt = await putRes.text().catch(() => '');
    console.error('[confirm-booking] contact PUT:', putRes.status, errTxt);
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
      `${GHL_BASE}/calendars/${GHL_CALENDAR_ID}?locationId=${GHL_LOCATION_ID}`,
      `${GHL_BASE}/locations/${GHL_LOCATION_ID}/calendars/${GHL_CALENDAR_ID}`,
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

  const assignedUserId = await resolveAssignedUserId();

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
      calendarId: GHL_CALENDAR_ID,
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

  outer: for (const includeAssignedUser of userPasses) {
    for (const { version, extra } of attempts) {
      for (const offsetMin of offsets) {
        const tryStartMs = startMs + offsetMin * 60 * 1000;
        const tryStart = new Date(tryStartMs);
        const tryEnd = new Date(tryStartMs + durationMin * 60 * 1000);

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

  return res.status(200).json(out);
}

function normalizeEmail(v) {
  return String(v ?? '').trim().toLowerCase();
}

function isValidEmail(s) {
  if (!s || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s);
}
