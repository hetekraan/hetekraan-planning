// api/confirm-booking.js
// Verwerkt de klantenkeuze uit de boekingspagina.
// Maakt de GHL-afspraak aan en stuurt WhatsApp bevestiging.

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, slotId } = req.body;
  if (!token || !slotId) return res.status(400).json({ error: 'token en slotId zijn verplicht' });

  // Decodeer booking-data uit token
  let bookingData;
  try {
    bookingData = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    return res.status(400).json({ error: 'Ongeldig token' });
  }

  const { contactId, name, phone, address, date: legacyDate, type, desc, slots } = bookingData;
  const chosenSlot = slots.find(s => s.id === slotId);
  if (!chosenSlot) return res.status(400).json({ error: 'Ongeldig slot' });

  // Datum: nieuw formaat heeft dateStr per slot, oud formaat heeft date op root
  const date = chosenSlot.dateStr || legacyDate;
  if (!date) return res.status(400).json({ error: 'Geen datum in slot' });

  // Bepaal exacte starttijd
  const block = chosenSlot.block || chosenSlot.id;
  const timeMap = { morning: '09:00', afternoon: '13:00' };
  const startTimeStr = chosenSlot.suggestedTime || timeMap[block] || '09:00';
  const [hours, minutes] = startTimeStr.split(':').map(Number);
  const durationMap = { installatie: 60, onderhoud: 30, reparatie: 45 };
  const durationMin = durationMap[type] || 30;

  const startMs = new Date(`${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00+01:00`).getTime();
  const endMs   = startMs + durationMin * 60 * 1000;

  // Sla adresgegevens op als custom fields
  if (address) {
    const parts = address.split(' ');
    const huisnummer = parts.find(p => /^\d/.test(p)) || '';
    const straatnaam = parts.slice(0, parts.findIndex(p => /^\d/.test(p))).join(' ') || address;
    await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
      body: JSON.stringify({
        customFields: [
          { id: FIELD_IDS.straatnaam,          field_value: straatnaam },
          { id: FIELD_IDS.huisnummer,          field_value: huisnummer },
          { id: FIELD_IDS.type_onderhoud,      field_value: type || 'reparatie' },
          { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
        ]
      })
    });
  }

  // Maak GHL-afspraak aan (met retry bij slot-conflict)
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

  // Stuur WhatsApp bevestiging via GHL tag (TESTMODUS: alleen loggen)
  const dateFormatted = new Date(`${date}T12:00:00+01:00`).toLocaleDateString('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  console.log(`[confirm-booking] TESTMODUS – WhatsApp bevestiging NIET verstuurd`);
  console.log(`[confirm-booking] Zou sturen: "${name}, je afspraak op ${dateFormatted} tussen ${chosenSlot.time} is bevestigd!"`);

  // In productie: addTag(contactId, 'boeking-bevestigd') → GHL workflow stuurt WhatsApp
  // await addTag(contactId, 'boeking-bevestigd');

  return res.status(200).json({
    success: true,
    appointmentId,
    contactId,
    slot: chosenSlot,
    date: dateFormatted,
  });
}

async function addTag(contactId, tag) {
  await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ tags: [tag] })
  });
}
