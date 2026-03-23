// api/suggest-slots.js
// Berekent de beste beschikbare tijdsloten voor een nieuwe klant,
// rekening houdend met de bestaande routes voor komende werkdagen.
// Wordt geopend vanuit GHL als Custom Menu Link.

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const MAPS_KEY        = process.env.GOOGLE_MAPS_KEY;
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const DEPOT           = 'Cornelis Dopperkade, Amsterdam';
const MAX_PER_BLOCK   = 4; // max afspraken per halve dag
const DAYS_AHEAD      = 7; // kijk zoveel dagen vooruit

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

// Bereken geografische afstand (km) via Haversine – snelle proxy voor reistijd
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Geocodeer een adres via Google Maps
async function geocode(address) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${MAPS_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'OK' && d.results[0]) {
      const loc = d.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch {}
  return null;
}

// Score hoe goed een nieuw adres in een bestaande routeset past (lager = beter)
// We berekenen de extra reisafstand als we dit adres aan de route toevoegen
function routeFitScore(newCoord, existingCoords) {
  if (existingCoords.length === 0) return 0; // lege dag = perfecte fit

  // Vind het dichtstbijzijnde bestaande punt → proxy voor hoeveel omrijden
  const minDist = Math.min(...existingCoords.map(c => haversine(newCoord.lat, newCoord.lng, c.lat, c.lng)));
  return minDist; // in km — lager is beter
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.method === 'POST' ? req.body : req.query;
  const { contactId, address: addressParam, name: nameParam, phone: phoneParam } = q;

  if (!contactId && !addressParam && !nameParam && !phoneParam) {
    return res.status(400).json({ error: 'contactId, address, name of phone vereist' });
  }

  // Haal contactgegevens op uit GHL
  let resolvedContactId = contactId || null;
  let contactName  = nameParam || '';
  let contactPhone = phoneParam || '';
  let address      = addressParam || '';

  if (resolvedContactId) {
    // Ophalen op ID
    try {
      const cr = await fetch(`${GHL_BASE}/contacts/${resolvedContactId}`, {
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
      });
      if (cr.ok) {
        const cd = await fetch(`${GHL_BASE}/contacts/${resolvedContactId}`, {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
        }).then(r => r.json());
        const contact = cd?.contact || cd;
        contactName  = contact.firstName ? `${contact.firstName} ${contact.lastName || ''}`.trim() : (contact.name || contactName);
        contactPhone = contact.phone || contactPhone;
        if (!address) {
          const straat     = getField(contact, FIELD_IDS.straatnaam);
          const huisnr     = getField(contact, FIELD_IDS.huisnummer);
          const postcode   = getField(contact, FIELD_IDS.postcode);
          const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
          address = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ') || contact.address1 || '';
        }
      }
    } catch {}
  } else {
    // Zoek contact op telefoon of naam
    const searchPhone = (phoneParam || '').replace(/\s/g, '');
    if (searchPhone) {
      try {
        const sr = await fetch(
          `${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(searchPhone)}`,
          { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
        );
        if (sr.ok) {
          const sd = await sr.json();
          const c  = sd?.contact;
          if (c?.id) {
            resolvedContactId = c.id;
            contactName  = c.firstName ? `${c.firstName} ${c.lastName || ''}`.trim() : (c.name || contactName);
            contactPhone = c.phone || contactPhone;
            if (!address) {
              const straat     = getField(c, FIELD_IDS.straatnaam);
              const huisnr     = getField(c, FIELD_IDS.huisnummer);
              const postcode   = getField(c, FIELD_IDS.postcode);
              const woonplaats = getField(c, FIELD_IDS.woonplaats) || c.city || '';
              address = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ') || c.address1 || '';
            }
          }
        }
      } catch {}
    }
    if (!resolvedContactId && nameParam) {
      try {
        const nr = await fetch(
          `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(nameParam)}&limit=1`,
          { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
        );
        if (nr.ok) {
          const nd = await nr.json();
          const c  = nd?.contacts?.[0];
          if (c?.id) {
            resolvedContactId = c.id;
            contactName  = c.firstName ? `${c.firstName} ${c.lastName || ''}`.trim() : (c.name || contactName);
            contactPhone = c.phone || contactPhone;
            if (!address) {
              const straat     = getField(c, FIELD_IDS.straatnaam);
              const huisnr     = getField(c, FIELD_IDS.huisnummer);
              const postcode   = getField(c, FIELD_IDS.postcode);
              const woonplaats = getField(c, FIELD_IDS.woonplaats) || c.city || '';
              address = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ') || c.address1 || '';
            }
          }
        }
      } catch {}
    }
  }

  // Geocodeer het adres van de nieuwe klant
  const newCoord = address ? await geocode(address) : null;

  // Bekijk de komende DAYS_AHEAD werkdagen
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const candidates = []; // { date, dateStr, block, label, score, existingCount }

  for (let d = 1; d <= DAYS_AHEAD + 3; d++) {
    const day = new Date(today);
    day.setDate(today.getDate() + d);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekend

    const dateStr  = day.toISOString().split('T')[0];

    // Skip geblokkeerde datums (vakantie/vrij)
    const blockedParam = q.blocked || '';
    if (blockedParam && blockedParam.split(',').includes(dateStr)) continue;
    const startMs  = new Date(`${dateStr}T00:00:00+01:00`).getTime();
    const endMs    = new Date(`${dateStr}T23:59:59+01:00`).getTime();

    // Haal afspraken op voor die dag
    let events = [];
    try {
      const er = await fetch(
        `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' } }
      );
      if (er.ok) {
        const ed = await er.json();
        events = ed?.events || [];
      }
    } catch {}

    const morningEvents   = events.filter(e => new Date(e.startTime).getHours() < 13);
    const afternoonEvents = events.filter(e => new Date(e.startTime).getHours() >= 13);

    // Geocodeer bestaande adressen voor route-fit berekening
    const geocodeEvents = async (evList) => {
      const coords = [];
      for (const e of evList) {
        if (e.address) {
          const c = await geocode(e.address);
          if (c) coords.push(c);
        }
      }
      return coords;
    };

    // Voeg beschikbare blokken toe als kandidaten
    for (const block of ['morning', 'afternoon']) {
      const blockEvents = block === 'morning' ? morningEvents : afternoonEvents;
      const count = blockEvents.length;
      if (count >= MAX_PER_BLOCK) continue;

      let score = count; // basis score: minder afspraken = beter

      // Route-fit score als we het adres hebben
      if (newCoord) {
        const existingCoords = await geocodeEvents(blockEvents);
        const fitScore = routeFitScore(newCoord, existingCoords);
        // Combineer: we willen volle blokken (minder lege km) maar toch route-efficiënt
        // Score = geografische afstand van dichtstbijzijnd punt × (1 + count/4)
        score = fitScore * (1 + count / MAX_PER_BLOCK);
      }

      candidates.push({
        date: day,
        dateStr,
        block,
        existingCount: count,
        score,
        timeLabel: block === 'morning' ? '09:00–13:00' : '13:00–17:00',
        blockLabel: block === 'morning' ? 'ochtend' : 'middag',
      });
    }

    if (candidates.length >= 6) break; // genoeg gevonden
  }

  // Sorteer op score (laagste = beste route-fit)
  candidates.sort((a, b) => a.score - b.score);

  // Geef de beste 2-3 opties terug
  const suggestions = candidates.slice(0, 3).map(c => ({
    dateStr:   c.dateStr,
    dateLabel: c.date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }),
    block:     c.block,
    blockLabel: c.blockLabel,
    timeLabel: c.timeLabel,
    existingCount: c.existingCount,
    slotsLeft: MAX_PER_BLOCK - c.existingCount,
    score:     Math.round(c.score * 10) / 10,
  }));

  return res.status(200).json({
    success: true,
    contactId: resolvedContactId,
    contactName,
    contactPhone,
    address,
    suggestions,
  });
}
