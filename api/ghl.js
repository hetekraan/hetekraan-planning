// api/ghl.js — met custom field IDs
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Custom field ID mapping
const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  postcode:            '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:          'mFRQjlUppycMfyjENKF9',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  prijs:               'HGjlT6ofaBiMz3j2HsXL', // vul in als bekend
  opmerkingen:         'YOUR_OPMERKINGEN_ID',
};

function getField(contact, fieldId) {
  if (!contact?.customFields) return '';
  const field = contact.customFields.find(f => f.id === fieldId);
  return field?.value || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    switch (action) {

      case 'getAppointments': {
        const { date } = req.query;
        const startMs = new Date(`${date}T00:00:00+01:00`).getTime();
        const endMs   = new Date(`${date}T23:59:59+01:00`).getTime();
        const url = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`;
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
        });
        const data = await response.json();
        const events = data?.events || [];

        const enriched = await Promise.all(events.map(async (e) => {
          if (!e.contactId) return e;
          try {
            const cr = await fetch(`${GHL_BASE}/contacts/${e.contactId}`, {
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
            });
            const cd = await cr.json();
            const contact = cd?.contact || cd;
            e.contact = contact;

            // Adres opbouwen uit custom fields
            const straat     = getField(contact, FIELD_IDS.straatnaam);
            const huisnr     = getField(contact, FIELD_IDS.huisnummer);
            const postcode   = getField(contact, FIELD_IDS.postcode);
            const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
            e.parsedAddress  = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ');

            // Werkzaamheden
            const type    = getField(contact, FIELD_IDS.type_onderhoud);
            const probleem = getField(contact, FIELD_IDS.probleemomschrijving);
            e.parsedWork  = [type, probleem].filter(Boolean).join(' — ') || e.title;

            // Prijs en opmerkingen
            e.parsedPrice = getField(contact, FIELD_IDS.prijs);
            e.parsedNotes = getField(contact, FIELD_IDS.opmerkingen);

          } catch(_) {}
          return e;
        }));

        return res.status(200).json({ events: enriched });
      }

      case 'completeAppointment': {
        const { contactId, appointmentId, type, sendReview, lastService } = req.body;
        const today = new Date().toISOString().split('T')[0];
        const customFields = [
          { id: 'hiTe3Yi5TlxheJq4bLzy', field_value: today } // datum_laatste_onderhoud
        ];
        if (type === 'installatie') {
          customFields.push({ id: 'kYP2SCmhZ21Ig0aaLl5l', field_value: today }); // datum_installatie
        }
        await fetch(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify({ customFields })
        });
        await addTag(contactId, 'factuur-versturen');
        if (sendReview) await addTag(contactId, 'review-mail-versturen');
        if (appointmentId) await updateOpportunityStage(contactId, 'Uitgevoerd');
        return res.status(200).json({ success: true });
      }

      case 'sendETA': {
        const { contactId, eta } = req.body;
        await fetch(`${GHL_BASE}/conversations/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify({
            type: 'WhatsApp',
            contactId,
            message: `Goedemiddag! Onze monteur is onderweg naar u. Verwachte aankomsttijd: ${eta}. Tot zo!`
          })
        });
        return res.status(200).json({ success: true });
      }

      case 'sendMorningMessages': {
        const { appointments } = req.body;
        for (const appt of appointments) {
          await fetch(`${GHL_BASE}/conversations/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              type: 'WhatsApp',
              contactId: appt.contactId,
              message: `Goedemorgen! U staat vandaag in onze planning. Onze monteur verwacht er tussen ${appt.timeFrom} en ${appt.timeTo} te zijn.`
            })
          });
        }
        return res.status(200).json({ success: true });
      }

      case 'optimizeRoute': {
        const { addresses } = req.body;
        const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

        // Bouw waypoints op
        const origin = addresses[0].address;
        const destination = addresses[addresses.length - 1].address;
        const waypoints = addresses.slice(1, -1).map(a => `optimize:true|${a.address}`).join('|');

        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&waypoints=${encodeURIComponent(waypoints)}&key=${GOOGLE_API_KEY}`;

        const r = await fetch(url);
        const d = await r.json();

        if (d.status === 'OK' && d.routes[0]?.waypoint_order) {
          const waypointOrder = d.routes[0].waypoint_order;
          // Bouw geoptimaliseerde volgorde op
          const middle = addresses.slice(1, -1);
          const optimized = [
            addresses[0].id,
            ...waypointOrder.map(i => middle[i].id),
            addresses[addresses.length - 1].id
          ];
          return res.status(200).json({ order: optimized });
        }

        return res.status(200).json({ order: null });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function addTag(contactId, tag) {
  await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ tags: [tag] })
  });
}

async function updateOpportunityStage(contactId, stage) {
  const res = await fetch(`${GHL_BASE}/opportunities/search?contact_id=${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await res.json();
  const opp = data?.opportunities?.[0];
  if (!opp) return;
  await fetch(`${GHL_BASE}/opportunities/${opp.id}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ status: stage })
  });
}
