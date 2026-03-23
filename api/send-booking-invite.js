// api/send-booking-invite.js
// Berekent de 2 beste tijdsloten voor een klant (op basis van adres + bestaande routes)
// en stuurt automatisch een WhatsApp-bericht via GHL met een boekingslink.

import { fetchWithRetry } from '../lib/retry.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const MAPS_KEY        = process.env.GOOGLE_MAPS_KEY;
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const MAX_PER_BLOCK   = 4;

/** Publieke basis-URL voor boekingslinks (Vercel: zet BASE_URL of gebruik automatisch VERCEL_URL) */
function publicBaseUrl() {
  const fromEnv = process.env.BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const vu = process.env.VERCEL_URL;
  if (vu) return `https://${vu.replace(/^https?:\/\//, '')}`;
  return 'https://hetekraan-planning.vercel.app';
}
const DAYS_AHEAD      = 7;

const FIELD_IDS = {
  straatnaam:  'ZwIMY4VPelG5rKROb5NR',
  huisnummer:  'co5Mr16rF6S6ay5hJOSJ',
  postcode:    '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:  'mFRQjlUppycMfyjENKF9',
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

async function getBestSlots(address) {
  const newCoord = address ? await geocode(address) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidates = [];

  for (let d = 1; d <= DAYS_AHEAD + 3 && candidates.length < 6; d++) {
    const day = new Date(today);
    day.setDate(today.getDate() + d);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue;

    const dateStr = day.toISOString().split('T')[0];
    const startMs = new Date(`${dateStr}T00:00:00+01:00`).getTime();
    const endMs   = new Date(`${dateStr}T23:59:59+01:00`).getTime();

    let events = [];
    try {
      const er = await fetch(
        `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' } }
      );
      if (er.ok) events = (await er.json())?.events || [];
    } catch {}

    const morningEvents   = events.filter(e => new Date(e.startTime).getHours() < 13);
    const afternoonEvents = events.filter(e => new Date(e.startTime).getHours() >= 13);

    for (const block of ['morning', 'afternoon']) {
      const blockEvents = block === 'morning' ? morningEvents : afternoonEvents;
      if (blockEvents.length >= MAX_PER_BLOCK) continue;

      let score = blockEvents.length;
      if (newCoord) {
        const coords = await geocodeEvents(blockEvents);
        const minDist = coords.length
          ? Math.min(...coords.map(c => haversine(newCoord.lat, newCoord.lng, c.lat, c.lng)))
          : 0;
        score = minDist * (1 + blockEvents.length / MAX_PER_BLOCK);
      }

      candidates.push({
        dateStr,
        date: day,
        block,
        existingCount: blockEvents.length,
        slotsLeft: MAX_PER_BLOCK - blockEvents.length,
        // ASCII-streepje (geen Unicode-en-dash): anders soms kapotte tekens op mobiel
        timeLabel: block === 'morning' ? '09:00 - 13:00' : '13:00 - 17:00',
        blockLabel: block === 'morning' ? 'ochtend' : 'middag',
        suggestedTime: block === 'morning' ? '09:00' : '13:00',
        dateLabel: day.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }),
        score,
      });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, 2);
}

const GHL_MSG_HEADERS = () => ({
  Authorization: `Bearer ${GHL_API_KEY}`,
  'Content-Type': 'application/json',
  Version: '2021-07-28',
});

async function listConversationsForContact(contactId) {
  const url = `${GHL_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${encodeURIComponent(contactId)}&limit=30`;
  const sr = await fetch(url, { headers: GHL_MSG_HEADERS() });
  if (!sr.ok) return [];
  const sd = await sr.json();
  return sd?.conversations || [];
}

/** Eerste hit is vaak géén WhatsApp (e-mail/SMS) → bericht kwam nergens aan. */
function isLikelyWhatsAppConversation(c) {
  if (!c) return false;
  const ch = String(
    c.lastMessageChannel || c.lastManualMessageChannel || c.channel || c.preferredChannel || ''
  ).toLowerCase();
  if (ch.includes('whatsapp')) return true;
  const t = c.type;
  if (t === 19 || t === 47) return true;
  if (String(t).toUpperCase().includes('WHATSAPP')) return true;
  return false;
}

async function getOrCreateConversation(contactId) {
  const sr = await fetch(
    `${GHL_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${encodeURIComponent(contactId)}&limit=5`,
    { headers: GHL_MSG_HEADERS() }
  );
  if (sr.ok) {
    const sd = await sr.json();
    const conv = sd?.conversations?.[0];
    if (conv?.id) return conv.id;
  }

  const cr = await fetch(`${GHL_BASE}/conversations/`, {
    method: 'POST',
    headers: GHL_MSG_HEADERS(),
    body: JSON.stringify({ locationId: GHL_LOCATION_ID, contactId })
  });
  if (cr.ok) {
    const cd = await cr.json();
    return cd?.conversation?.id || cd?.id || null;
  }
  const errTxt = await cr.text().catch(() => '');
  console.error('[send-booking-invite] conversations/ POST mislukt:', cr.status, errTxt);
  return null;
}

/**
 * Probeert meerdere GHL-payloads: alleen contactId (zoals ghl.js sendMorningMessages),
 * daarna expliciete WhatsApp-threads, daarna legacy conversationId.
 */
async function sendWhatsAppMessage(contactId, message, diag) {
  const attempts = [];
  const push = (mode, res, detail) => {
    attempts.push({
      mode,
      ok: res.ok,
      status: res.status,
      detail: typeof detail === 'string' ? detail.slice(0, 400) : null,
    });
  };

  async function post(payload) {
    return fetchWithRetry(`${GHL_BASE}/conversations/messages`, {
      method: 'POST',
      headers: GHL_MSG_HEADERS(),
      body: JSON.stringify(payload),
    });
  }

  // 1) Alleen contactId — werkt in veel subaccounts (geen verkeerde conversationId)
  let res = await post({ type: 'WhatsApp', contactId, message });
  let errBody = res.ok ? '' : await res.text().catch(() => '');
  push('WhatsApp + alleen contactId + message', res, errBody);
  if (res.ok) {
    diag.whatsappAttempts = attempts;
    return true;
  }

  // 1b) Sommige GHL-versies verwachten "body" i.p.v. "message"
  res = await post({ type: 'WhatsApp', contactId, body: message });
  errBody = res.ok ? '' : await res.text().catch(() => '');
  push('WhatsApp + alleen contactId + body', res, errBody);
  if (res.ok) {
    diag.whatsappAttempts = attempts;
    return true;
  }

  // 2) Met locationId (sommige setups verwachten dit)
  res = await post({ type: 'WhatsApp', contactId, message, locationId: GHL_LOCATION_ID });
  errBody = res.ok ? '' : await res.text().catch(() => '');
  push('WhatsApp + contactId + locationId + message', res, errBody);
  if (res.ok) {
    diag.whatsappAttempts = attempts;
    return true;
  }

  res = await post({ type: 'WhatsApp', contactId, body: message, locationId: GHL_LOCATION_ID });
  errBody = res.ok ? '' : await res.text().catch(() => '');
  push('WhatsApp + contactId + locationId + body', res, errBody);
  if (res.ok) {
    diag.whatsappAttempts = attempts;
    return true;
  }

  // 3) Zoek WhatsApp-gesprek, niet alleen conversations[0]
  const convs = await listConversationsForContact(contactId);
  const wa = convs.filter(isLikelyWhatsAppConversation);
  const rest = convs.filter(c => !isLikelyWhatsAppConversation(c));
  const tryOrder = [...wa, ...rest];

  for (const conv of tryOrder.slice(0, 15)) {
    const convId = conv?.id;
    if (!convId) continue;
    res = await post({ type: 'WhatsApp', conversationId: convId, contactId, message });
    errBody = res.ok ? '' : await res.text().catch(() => '');
    push(`WhatsApp + conversationId (${convId.slice(0, 8)}…)`, res, errBody);
    if (res.ok) {
      diag.whatsappAttempts = attempts;
      return true;
    }
  }

  // 4) Fallback: oude gedrag (eerste / nieuwe conversatie)
  const fallbackConv = await getOrCreateConversation(contactId);
  if (fallbackConv) {
    res = await post({ type: 'WhatsApp', conversationId: fallbackConv, contactId, message });
    errBody = res.ok ? '' : await res.text().catch(() => '');
    push('WhatsApp + fallback getOrCreateConversation', res, errBody);
    if (res.ok) {
      diag.whatsappAttempts = attempts;
      return true;
    }
  } else {
    attempts.push({ mode: 'geen conversationId (aanmaken mislukt)', ok: false, status: 0, detail: null });
  }

  diag.whatsappAttempts = attempts;
  console.error('[send-booking-invite] Alle WhatsApp-pogingen mislukt:', JSON.stringify(attempts));
  return false;
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

/** Als API-WhatsApp faalt: workflow op tag stuur-tijdsloten — alleen met BOOKING_FALLBACK_TAG=true (anders dubbel met field-workflow). */
async function applyStuurTijdslotenTag(contactId, diag) {
  const delRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-07-28',
    },
    body: JSON.stringify({ tags: ['stuur-tijdsloten'] }),
  });
  diag.tagFallbackRemove = delRes.ok;
  await new Promise((r) => setTimeout(r, 2000));
  const addRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-07-28',
    },
    body: JSON.stringify({ tags: ['stuur-tijdsloten'] }),
  });
  diag.tagFallbackAdd = addRes.ok;
  if (!addRes.ok) {
    const t = await addRes.text().catch(() => '');
    diag.tagFallbackError = t.slice(0, 400);
  }
  return addRes.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = parseRequestBody(req);
  let { contactId, name: nameParam, phone: phoneParam, address: addressParam } = body;

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

  /** Vóór token: sync 06… → +31… zodat bookingData.phone en WhatsApp kloppen. */
  let phoneSyncedToE164 = false;
  const normPhone0 = normalizeNlPhone(contact.phone || '');
  if (normPhone0 && /^\+31[1-9]\d{8}$/.test(normPhone0)) {
    const raw = String(contact.phone || '').trim();
    if (!raw.startsWith('+')) {
      const sync = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({ phone: normPhone0 }),
      });
      phoneSyncedToE164 = sync.ok;
      if (sync.ok) contact.phone = normPhone0;
    }
  }

  // Bereken de 2 beste slots
  const slots = await getBestSlots(address);
  if (slots.length === 0) {
    return res.status(200).json({ success: false, message: 'Geen beschikbare slots in de komende 7 werkdagen.' });
  }

  // Bouw boekingstoken (bevat beide opties zodat klant kan kiezen)
  const bookingData = {
    contactId,
    name,
    phone: contact.phone || '',
    address,
    slots: slots.map(s => ({
      id:            `${s.dateStr}_${s.block}`,
      dateStr:       s.dateStr,
      block:         s.block,
      label:         `${capitalize(s.dateLabel)} ${s.blockLabel}`,
      time:          s.timeLabel,
      suggestedTime: s.suggestedTime,
    })),
  };
  const token = Buffer.from(JSON.stringify(bookingData)).toString('base64url');
  // Pad-URL: sommige apps/webviews gaan beter om met een lang pad dan met een enorme querystring
  const bookingUrl = `${publicBaseUrl()}/book/${encodeURIComponent(token)}`;

  // Custom field IDs voor GHL workflow
  const FIELD_SLOT1  = 'EiSw9gZQSG4kyhPn1rtF'; // Tijdslot optie 1
  const FIELD_SLOT2  = '7Fi0c2XTjEiZve3ORFjM'; // Tijdslot optie 2
  const FIELD_TOKEN  = 'whvgJ2ILKYukDlVj81rp'; // Boekings token

  // Bouw WhatsApp bericht
  const slot1 = slots[0];
  const slot2 = slots[1];
  let message = `We hebben nog een gaatje op een van de volgende twee tijdslots:\n\n`;
  message += `*Optie 1:* ${capitalize(slot1.dateLabel)} tussen ${slot1.timeLabel}\n`;
  if (slot2) message += `*Optie 2:* ${capitalize(slot2.dateLabel)} tussen ${slot2.timeLabel}\n`;
  message += `\nKlik op de link om jouw voorkeur door te geven, dan plannen we het gelijk in:\n${bookingUrl}`;

  // Sla tijdsloten + token op als custom fields voor het WhatsApp template
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
    directWhatsapp: false,
    phoneSyncedToE164,
  };

  // Standaard GEEN tag: workflow op "Boekings token" triggert één keer.
  // Zet BOOKING_ADD_TAG=true in Vercel als je alleen een workflow op tag stuur-tijdsloten gebruikt.
  const addBookingTag = process.env.BOOKING_ADD_TAG === 'true';

  // Phone meesturen: sommige GHL-PUTs overschrijven het hele contact-object zonder merge.
  const fieldsRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({
      customFields,
      ...(contact.phone ? { phone: contact.phone } : {}),
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
    console.log('[send-booking-invite] BOOKING_ADD_TAG=false — geen stuur-tijdsloten tag (alleen custom fields)');
  }

  // Standaard: WhatsApp direct via GHL Conversations API (betrouwbaar).
  // Gebruik je al een GHL-workflow die hetzelfde bericht stuurt? Zet dan op Vercel:
  // BOOKING_SEND_DIRECT_WHATSAPP=false (anders dubbel bericht).
  const sendDirectWhatsapp = process.env.BOOKING_SEND_DIRECT_WHATSAPP !== 'false';
  let messageSent = false;
  diag.directWhatsapp = false;
  if (sendDirectWhatsapp) {
    messageSent = await sendWhatsAppMessage(contactId, message, diag);
    diag.directWhatsapp = messageSent;
  }

  // Laatste redmiddel: zelfde tag-sequence als BOOKING_ADD_TAG (alleen bij expliciete env).
  if (!messageSent && sendDirectWhatsapp && process.env.BOOKING_FALLBACK_TAG === 'true') {
    diag.tagFallbackTriggered = true;
    await applyStuurTijdslotenTag(contactId, diag);
  }

  const pCheck = normalizeNlPhone(contact.phone || '');
  const phoneOk = /^\+31[1-9]\d{8}$/.test(pCheck);
  return res.status(200).json({
    success: true,
    messageSent,
    contactName: name,
    contactPhonePresent: phoneOk,
    slots: slots.map(s => ({ dateLabel: s.dateLabel, timeLabel: s.timeLabel, block: s.block })),
    bookingUrl,
    message,
    diag,
    workflowTip:
      '1) Open Network-tab bij “Stuur”: kijk naar diag.whatsappAttempts[].detail (GHL-fouttekst). ' +
      '2) Test alleen WhatsApp-API: POST /api/booking-whatsapp-test met header x-booking-debug-secret (zet BOOKING_DEBUG_SECRET in Vercel). ' +
      '3) Nummer moet in GHL als +31… (we syncen vanaf 06… automatisch). ' +
      '4) API lukt niet maar workflow wel? Zet BOOKING_FALLBACK_TAG=true (triggert tag stuur-tijdsloten) — niet combineren met een tweede workflow op hetzelfde moment. ' +
      '5) Private app in GHL: scopes o.a. conversations.write / messages.',
  });
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
