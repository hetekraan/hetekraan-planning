// api/booking.js — slim boekingssysteem met route-optimalisatie
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const GOOGLE_API_KEY  = process.env.GOOGLE_MAPS_API_KEY;

const DEPOT = 'Cornelis Dopperkade, Amsterdam';

// Beschikbare tijdslots (uur als decimaal)
const SLOT_HOURS = [8, 9.5, 11, 12.5, 14, 15.5];
const SLOT_DURATION_MIN = 90;

// Custom field IDs
const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  postcode:            '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:          'mFRQjlUppycMfyjENKF9',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
};

function slotLabel(h) {
  const hours = Math.floor(h);
  const mins = Math.round((h % 1) * 60);
  return `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
}

function slotEndLabel(h) {
  return slotLabel(h + SLOT_DURATION_MIN / 60);
}

async function getAppointmentsForDay(dateStr) {
  const startMs = new Date(`${dateStr}T00:00:00+01:00`).getTime();
  const endMs   = new Date(`${dateStr}T23:59:59+01:00`).getTime();
  const url = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const data = await res.json();
    return data?.events || [];
  } catch (_) { return []; }
}

// Haalt adres op uit GHL contact custom fields
async function getContactAddress(contactId) {
  if (!contactId) return '';
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const data = await res.json();
    const contact = data?.contact || data;
    const cf = contact?.customFields || [];
    const get = id => cf.find(f => f.id === id)?.value || '';
    const parts = [get(FIELD_IDS.straatnaam), get(FIELD_IDS.huisnummer), get(FIELD_IDS.postcode), get(FIELD_IDS.woonplaats) || contact?.city || ''];
    return parts.filter(Boolean).join(' ');
  } catch (_) { return ''; }
}

// Berekent reisafstand van nieuw adres naar dichtstbijzijnde bestaande afspraak
async function nearestDistanceMeters(existingAddresses, newAddress) {
  if (!GOOGLE_API_KEY || existingAddresses.length === 0) return null;
  try {
    const origins = encodeURIComponent(newAddress);
    const dests = existingAddresses.slice(0, 10).map(a => encodeURIComponent(a)).join('|');
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${dests}&key=${GOOGLE_API_KEY}&language=nl&units=metric`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return null;
    const elements = data.rows[0]?.elements || [];
    const valid = elements.filter(e => e.status === 'OK').map(e => e.distance?.value || 999999);
    return valid.length ? Math.min(...valid) : null;
  } catch (_) { return null; }
}

// Bepaalt welke slots bezet zijn op basis van afspraken
function getBookedHours(events) {
  return events.map(e => {
    const start = new Date(e.startTime);
    return start.getHours() + start.getMinutes() / 60;
  });
}

// Zoek of maak contact aan in GHL
async function findOrCreateContact({ firstName, lastName, phone, email, address, workType, description }) {
  // Zoek op telefoonnummer
  try {
    const searchRes = await fetch(`${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(phone)}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const searchData = await searchRes.json();
    const existing = searchData?.contacts?.[0];
    if (existing) return existing.id;
  } catch (_) {}

  // Adres parsen voor custom fields
  const parts = (address || '').split(' ');
  const pcIdx = parts.findIndex(p => /^\d{4}[A-Za-z]{2}$/.test(p));
  const straat = parts.slice(0, Math.max(0, pcIdx - 1)).join(' ');
  const huisnr = pcIdx > 0 ? parts[pcIdx - 1] : '';
  const postcode = pcIdx >= 0 ? parts[pcIdx].toUpperCase() : '';
  const woonplaats = pcIdx >= 0 ? parts.slice(pcIdx + 1).join(' ') : '';

  const customFields = [
    { id: FIELD_IDS.type_onderhoud,       field_value: workType || '' },
    { id: FIELD_IDS.probleemomschrijving, field_value: description || '' },
    ...(address ? [
      { id: FIELD_IDS.straatnaam,  field_value: straat },
      { id: FIELD_IDS.huisnummer,  field_value: huisnr },
      { id: FIELD_IDS.postcode,    field_value: postcode },
      { id: FIELD_IDS.woonplaats,  field_value: woonplaats },
    ] : [])
  ].filter(f => f.field_value);

  const createRes = await fetch(`${GHL_BASE}/contacts/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      firstName,
      lastName: lastName || '',
      phone,
      email: email || '',
      address1: address || '',
      customFields,
    }),
  });
  const createData = await createRes.json();
  return createData?.contact?.id || createData?.id || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'GET' ? req.query : req.body;
  const { action } = params;

  try {
    switch (action) {

      // Geeft beschikbare dagen terug (volgende 14 werkdagen)
      case 'getDays': {
        const days = [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dayPromises = [];
        const dayMeta = [];

        for (let i = 1; i <= 28 && dayMeta.length < 14; i++) {
          const d = new Date(today.getTime() + i * 86400000);
          if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekend
          const dateStr = d.toLocaleDateString('sv-SE'); // YYYY-MM-DD
          dayMeta.push({ d, dateStr });
          dayPromises.push(getAppointmentsForDay(dateStr));
        }

        const results = await Promise.all(dayPromises);

        for (let i = 0; i < dayMeta.length; i++) {
          const { d, dateStr } = dayMeta[i];
          const events = results[i];
          const booked = getBookedHours(events);
          const available = SLOT_HOURS.filter(h => !booked.some(b => Math.abs(b - h) < 1));
          if (available.length > 0) {
            days.push({
              date: dateStr,
              dayName: d.toLocaleDateString('nl-NL', { weekday: 'long' }),
              dayShort: d.toLocaleDateString('nl-NL', { weekday: 'short' }),
              dayNumber: d.getDate(),
              month: d.toLocaleDateString('nl-NL', { month: 'long' }),
              monthShort: d.toLocaleDateString('nl-NL', { month: 'short' }),
              slotsAvailable: available.length,
              totalSlots: SLOT_HOURS.length,
              bookedCount: booked.length,
            });
          }
        }
        return res.status(200).json({ days });
      }

      // Geeft tijdslots terug voor een dag, gerangschikt op route-vriendelijkheid
      case 'getSlots': {
        const { date, address } = params;
        if (!date) return res.status(400).json({ error: 'date vereist' });

        const events = await getAppointmentsForDay(date);
        const booked = getBookedHours(events);

        // Haal adressen bestaande afspraken op
        let existingAddresses = [DEPOT];
        if (address) {
          const addrPromises = events.filter(e => e.contactId).map(e => getContactAddress(e.contactId));
          const addrs = await Promise.all(addrPromises);
          existingAddresses = [DEPOT, ...addrs.filter(Boolean)];
        }

        // Bereken routeafstand van klantadres naar bestaande route
        let distMeters = null;
        if (address && existingAddresses.length > 1) {
          distMeters = await nearestDistanceMeters(existingAddresses, address);
        }

        const slots = SLOT_HOURS.map(h => ({
          time: slotLabel(h),
          timeEnd: slotEndLabel(h),
          hour: h,
          available: !booked.some(b => Math.abs(b - h) < 1),
        }));

        return res.status(200).json({
          slots,
          existingCount: events.length,
          routeDistanceMeters: distMeters,
          routeDistanceKm: distMeters ? Math.round(distMeters / 100) / 10 : null,
        });
      }

      // Boekt een afspraak aan
      case 'createBooking': {
        const { firstName, lastName, phone, email, address, date, time, workType, description } = params;

        if (!firstName || !phone || !date || !time) {
          return res.status(400).json({ error: 'Verplichte velden ontbreken: naam, telefoon, datum, tijd' });
        }

        const contactId = await findOrCreateContact({ firstName, lastName, phone, email, address, workType, description });
        if (!contactId) return res.status(500).json({ error: 'Kon contact niet aanmaken in GHL' });

        const [hours, mins] = time.split(':').map(Number);
        const startTime = new Date(`${date}T${time}:00+01:00`);
        const endTime   = new Date(startTime.getTime() + SLOT_DURATION_MIN * 60 * 1000);

        const apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-04-15',
          },
          body: JSON.stringify({
            calendarId:  GHL_CALENDAR_ID,
            locationId:  GHL_LOCATION_ID,
            contactId,
            startTime:   startTime.toISOString(),
            endTime:     endTime.toISOString(),
            title:       `${workType || 'Afspraak'} — ${firstName} ${lastName || ''}`.trim(),
            address:     address || '',
          }),
        });
        const apptData = await apptRes.json();

        return res.status(200).json({
          success: true,
          contactId,
          appointmentId: apptData?.id,
          date,
          time,
        });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    console.error('Booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
