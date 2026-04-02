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
import {
  blockAllowsNewCustomerBooking,
  customerMaxForBlock,
  normalizeWorkType,
} from '../lib/booking-blocks.js';
import { maxCustomerAppointmentsPerDay } from '../lib/calendar-customer-cap.js';
import { fetchWithRetry } from '../lib/retry.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { signBookingToken } from '../lib/session.js';
import { dayHasBlockedSlotsOverlappingWorkHours } from '../lib/ghl-calendar-blocks.js';
import {
  DAYPART_SPLIT_HOUR,
  DEFAULT_BOOK_START_AFTERNOON,
  DEFAULT_BOOK_START_MORNING,
  SLOT_LABEL_AFTERNOON_SPACE,
  SLOT_LABEL_MORNING_SPACE,
} from '../lib/planning-work-hours.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const MAPS_KEY        = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

const blockSlotCtx = () => ({
  locationId: GHL_LOCATION_ID,
  calendarId: GHL_CALENDAR_ID,
  apiKey: GHL_API_KEY,
});

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

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function geocode(address) {
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${MAPS_KEY}`);
    const d = await r.json();
    if (d.status === 'OK' && d.results[0]) {
      const loc = d.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch {}
  return null;
}

async function geocodeEvents(events) {
  const coords = [];
  for (const e of events) {
    if (e.address) {
      const c = await geocode(e.address);
      if (c) coords.push(c);
    }
  }
  return coords;
}

async function getBestSlots(address, workType) {
  const newCoord = address ? await geocode(address) : null;
  const candidates = [];

  const todayAmsterdam = formatYyyyMmDdInAmsterdam(new Date());
  if (!todayAmsterdam) return [];
  let dateStr = addAmsterdamCalendarDays(todayAmsterdam, 1);
  if (!dateStr) return [];

  for (let step = 1; step <= DAYS_AHEAD + 3 && candidates.length < 6; step++) {
    const dow = amsterdamWeekdaySun0(dateStr);
    if (dow === 0 || dow === 6) {
      dateStr = addAmsterdamCalendarDays(dateStr, 1);
      continue;
    }

    if (await dayHasBlockedSlotsOverlappingWorkHours(GHL_BASE, blockSlotCtx(), dateStr)) {
      dateStr = addAmsterdamCalendarDays(dateStr, 1);
      continue;
    }

    const bounds = amsterdamCalendarDayBoundsMs(dateStr);
    if (!bounds) break;
    const { startMs, endMs } = bounds;

    let events = [];
    try {
      const er = await fetch(
        `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`,
        { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' } }
      );
      if (er.ok) events = (await er.json())?.events || [];
    } catch {}

    const dayCap = maxCustomerAppointmentsPerDay();
    if (events.length >= dayCap) {
      dateStr = addAmsterdamCalendarDays(dateStr, 1);
      continue;
    }

    const morningEvents = events.filter((e) => hourInAmsterdam(e.startTime) < DAYPART_SPLIT_HOUR);
    const afternoonEvents = events.filter((e) => hourInAmsterdam(e.startTime) >= DAYPART_SPLIT_HOUR);

    const noon = amsterdamWallTimeToDate(dateStr, 12, 0);
    const dateLabel = noon
      ? noon.toLocaleDateString('nl-NL', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          timeZone: 'Europe/Amsterdam',
        })
      : dateStr;

    for (const block of ['morning', 'afternoon']) {
      const blockEvents = block === 'morning' ? morningEvents : afternoonEvents;
      if (!blockAllowsNewCustomerBooking(block, blockEvents, workType)) continue;

      const maxB = customerMaxForBlock(block);
      let score = blockEvents.length;
      if (newCoord) {
        const coords = await geocodeEvents(blockEvents);
        const minDist = coords.length
          ? Math.min(...coords.map((c) => haversine(newCoord.lat, newCoord.lng, c.lat, c.lng)))
          : 0;
        score = minDist * (1 + blockEvents.length / maxB);
      }

      candidates.push({
        dateStr,
        block,
        existingCount: blockEvents.length,
        slotsLeft: maxB - blockEvents.length,
        timeLabel: block === 'morning' ? SLOT_LABEL_MORNING_SPACE : SLOT_LABEL_AFTERNOON_SPACE,
        blockLabel: block === 'morning' ? 'ochtend' : 'middag',
        suggestedTime: block === 'morning' ? DEFAULT_BOOK_START_MORNING : DEFAULT_BOOK_START_AFTERNOON,
        dateLabel,
        score,
      });
    }

    dateStr = addAmsterdamCalendarDays(dateStr, 1);
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, 2);
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

  // Bereken de 2 beste slots (rekening houdend met max 4/3 per blok + geplande minuten)
  const slots = await getBestSlots(address, workType);
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
    slots: slots.map(s => ({
      id:            `${s.dateStr}_${s.block}`,
      dateStr:       s.dateStr,
      block:         s.block,
      label:         `${capitalize(s.dateLabel)} ${s.blockLabel}`,
      time:          s.timeLabel,
      suggestedTime: s.suggestedTime,
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
