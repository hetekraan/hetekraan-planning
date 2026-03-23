// api/send-booking-invite.js
// Berekent de 2 beste tijdsloten voor een klant (op basis van adres + bestaande routes)
// en stuurt automatisch een WhatsApp-bericht via GHL met een boekingslink.

import { fetchWithRetry } from '../lib/retry.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const MAPS_KEY        = process.env.GOOGLE_MAPS_KEY;
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const BASE_URL        = 'https://hetekraan-planning.vercel.app';
const MAX_PER_BLOCK   = 4;
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
        timeLabel: block === 'morning' ? '09:00–13:00' : '13:00–17:00',
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

async function getOrCreateConversation(contactId) {
  // Zoek bestaande conversatie
  const sr = await fetch(
    `${GHL_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`,
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' } }
  );
  if (sr.ok) {
    const sd = await sr.json();
    const conv = sd?.conversations?.[0];
    if (conv?.id) return conv.id;
  }

  // Maak nieuwe conversatie aan
  const cr = await fetch(`${GHL_BASE}/conversations/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ locationId: GHL_LOCATION_ID, contactId })
  });
  if (cr.ok) {
    const cd = await cr.json();
    return cd?.conversation?.id || cd?.id || null;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.method === 'POST' ? req.body : req.query;
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
          phone: (phoneParam || '').replace(/\s/g, '') || '',
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
  const bookingUrl = `${BASE_URL}/book?token=${token}`;

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

  const diag = { fieldsPut: false, tagRemove: false, tagAdd: false, directWhatsapp: false };

  // Standaard GEEN tag: workflow op "Boekings token" triggert één keer.
  // Zet BOOKING_ADD_TAG=true in Vercel als je alleen een workflow op tag stuur-tijdsloten gebruikt.
  const addBookingTag = process.env.BOOKING_ADD_TAG === 'true';

  const fieldsRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ customFields })
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

  // Standaard GEEN tweede WhatsApp via conversations API: die zou dubbel zijn met het GHL-template
  // (workflow op tag / Boekings token). Zet BOOKING_SEND_DIRECT_WHATSAPP=true als je tóch beide wilt.
  let messageSent = false;
  diag.directWhatsapp = false;
  if (process.env.BOOKING_SEND_DIRECT_WHATSAPP === 'true') {
    const conversationId = await getOrCreateConversation(contactId);
    if (conversationId) {
      const mr = await fetch(`${GHL_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-04-15',
        },
        body: JSON.stringify({ type: 'WhatsApp', conversationId, contactId, message })
      });
      messageSent = mr.ok;
      diag.directWhatsapp = mr.ok;
      if (!mr.ok) console.log('[send-booking-invite] Direct sturen mislukt');
    }
  }

  return res.status(200).json({
    success: true,
    messageSent,
    contactName: name,
    slots: slots.map(s => ({ dateLabel: s.dateLabel, timeLabel: s.timeLabel, block: s.block })),
    bookingUrl,
    message,
    diag,
    workflowTip:
      'Als je geen WhatsApp krijgt: (1) Workflow moet actief zijn. (2) Trigger exacte tag: stuur-tijdsloten. ' +
      '(3) Betrouwbaarder: maak een tweede workflow met trigger "Custom field updated" op veld Boekings token — die triggert altijd als wij de link opslaan.',
  });
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
