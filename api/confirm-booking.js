// api/confirm-booking.js
// Verwerkt de klantenkeuze uit de boekingspagina.
// Maakt de GHL-afspraak aan; WhatsApp alleen via GHL-workflow (tag-puls).

import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { fetchWithRetry } from '../lib/retry.js';
import { pulseContactTag } from '../lib/ghl-tag.js';

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

/** Tekst voor GHL custom field "Tijdafspraak" / template-variabele 1 */
function formatBevestigingVoorTemplate(dateStr, slot) {
  const d = new Date(`${dateStr}T12:00:00+01:00`);
  const datePart = d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
  const timeRaw = String(slot?.time || '').replace(/\u2013|\u2014|\u2212/g, ' - ').trim();
  const times = timeRaw.match(/\d{1,2}:\d{2}/g);
  let timePart;
  if (times && times.length >= 2) {
    const h1 = parseInt(times[0].split(':')[0], 10);
    const h2 = parseInt(times[1].split(':')[0], 10);
    timePart = `${h1} en ${h2} uur`;
  } else if (times?.length === 1) {
    const h = parseInt(times[0].split(':')[0], 10);
    timePart = `om ${h} uur`;
  } else {
    timePart = timeRaw || 'het afgesproken tijdstip';
  }
  return `${datePart} tussen ${timePart}`;
}

function firstValidNlMobile(...candidates) {
  for (const c of candidates) {
    const n = normalizeNlPhone(String(c ?? '').trim());
    if (/^\+31[1-9]\d{8}$/.test(n)) return n;
  }
  return '';
}

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

  let bookingData;
  try {
    bookingData = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    return res.status(400).json({ error: 'Ongeldig token' });
  }

  const { contactId, name, phone, address, date: legacyDate, type, desc, slots, email: emailInToken } = bookingData;
  const chosenSlot = slots.find(s => s.id === slotId);
  if (!chosenSlot) return res.status(400).json({ error: 'Ongeldig slot' });

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

  const block = chosenSlot.block || chosenSlot.id;
  const timeMap = { morning: '09:00', afternoon: '13:00' };
  const startTimeStr = chosenSlot.suggestedTime || timeMap[block] || '09:00';
  const [hours, minutes] = startTimeStr.split(':').map(Number);
  const durationMap = { installatie: 60, onderhoud: 30, reparatie: 45 };
  const durationMin = durationMap[type] || 30;

  const startMs = new Date(`${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00+01:00`).getTime();

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
      { id: FIELD_IDS.type_onderhoud, field_value: type || 'reparatie' },
      { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
    ];
  }

  const bevestigingTemplate1 = formatBevestigingVoorTemplate(date, chosenSlot);
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
    return res.status(502).json({ error: 'Kon gegevens niet opslaan in GHL. Probeer het later opnieuw.' });
  }

  const offsets = [0, -5, 5, -10, 10, -15, 15, -30, 30];
  let appointmentId = null;
  let lastError = null;

  for (const offsetMin of offsets) {
    const tryStart = new Date(startMs + offsetMin * 60 * 1000);
    const tryEnd   = new Date(startMs + offsetMin * 60 * 1000 + durationMin * 60 * 1000);

    const apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({
        calendarId: GHL_CALENDAR_ID,
        locationId: GHL_LOCATION_ID,
        contactId,
        startTime: tryStart.toISOString(),
        endTime: tryEnd.toISOString(),
        title: `${name} – ${type || 'afspraak'}`,
        appointmentStatus: 'confirmed',
        ignoreLimits: true,
      })
    });

    if (apptRes.ok) {
      const apptData = await apptRes.json();
      appointmentId = apptData?.id;
      break;
    }
    const errText = await apptRes.text();
    lastError = errText;
    if (!errText.includes('slot') && !errText.includes('available')) break;
  }

  if (!appointmentId) {
    console.error('[confirm-booking] Alle slots geprobeerd, mislukt:', lastError);
    return res.status(500).json({ error: 'Kon geen afspraak aanmaken in de agenda' });
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
