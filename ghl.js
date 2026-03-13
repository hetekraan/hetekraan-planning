// api/ghl.js
// Serverless function — draait op Vercel, praat met GHL

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    switch (action) {

      // Haal afspraken van een dag op
      case 'getAppointments': {
        const { date } = req.query;
        // Haal afspraken op voor specifieke kalender en dag
        const url = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${date}T00:00:00Z&endTime=${date}T23:59:59Z`;
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-04-15'
          }
        });
        const data = await response.json();
        // Haal ook contactgegevens op per afspraak
        const events = data?.events || [];
        const enriched = await Promise.all(events.map(async (e) => {
          if (!e.contactId) return e;
          try {
            const cr = await fetch(`${GHL_BASE}/contacts/${e.contactId}`, {
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
            });
            const cd = await cr.json();
            e.contact = cd?.contact || cd;
          } catch(_) {}
          return e;
        }));
        return res.status(200).json({ events: enriched });
      }

      // Markeer afspraak als klaar + trigger workflows
      case 'completeAppointment': {
        const { contactId, appointmentId, type, sendReview, lastService, serviceDate } = req.body;

        // 1. Update contact velden in GHL
        const fields = {
          customFields: []
        };

        // Sla datum laatste onderhoud op
        const today = new Date().toISOString().split('T')[0];
        fields.customFields.push({ key: 'laatste_onderhoudsbeurt', field_value: today });

        // Bij reparatie: sla opgegeven datum in
        if (type === 'reparatie' && lastService) {
          fields.customFields.push({ key: 'laatste_onderhoudsbeurt', field_value: lastService });
        }

        // Sla datum installatie op als het installatie was
        if (type === 'installatie') {
          fields.customFields.push({ key: 'datum_installatie', field_value: today });
        }

        // Update contact
        await fetch(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-04-15'
          },
          body: JSON.stringify(fields)
        });

        // 2. Trigger factuur workflow via tag
        await addTag(contactId, 'factuur-versturen');

        // 3. Trigger review mail workflow (volgende dag) als aangevinkt
        if (sendReview) {
          await addTag(contactId, 'review-mail-versturen');
        }

        // 4. Pipeline naar "Uitgevoerd"
        if (appointmentId) {
          await updateOpportunityStage(contactId, 'Uitgevoerd');
        }

        return res.status(200).json({ success: true });
      }

      // Stuur ETA bericht naar volgende klant
      case 'sendETA': {
        const { contactId, eta, monteurNaam } = req.body;

        await fetch(`${GHL_BASE}/conversations/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-04-15'
          },
          body: JSON.stringify({
            type: 'WhatsApp',
            contactId,
            message: `Goedemiddag! Onze monteur is onderweg naar u. Verwachte aankomsttijd: ${eta}. Tot zo!`
          })
        });

        return res.status(200).json({ success: true });
      }

      // Stuur ochtendmelding naar alle klanten van de dag
      case 'sendMorningMessages': {
        const { appointments } = req.body;

        for (const appt of appointments) {
          await fetch(`${GHL_BASE}/conversations/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-04-15'
            },
            body: JSON.stringify({
              type: 'WhatsApp',
              contactId: appt.contactId,
              message: `Goedemorgen! U staat vandaag in onze planning. Onze monteur verwacht er tussen ${appt.timeFrom} en ${appt.timeTo} te zijn. Bij vragen kunt u ons bereiken via dit nummer.`
            })
          });
        }

        return res.status(200).json({ success: true });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// Helper: voeg tag toe aan contact (triggert workflow in GHL)
async function addTag(contactId, tag) {
  await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({ tags: [tag] })
  });
}

// Helper: update opportunity stage
async function updateOpportunityStage(contactId, stage) {
  // Haal eerst opportunity op voor dit contact
  const res = await fetch(`${GHL_BASE}/opportunities/search?contact_id=${contactId}`, {
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-04-15'
    }
  });
  const data = await res.json();
  const opp = data?.opportunities?.[0];
  if (!opp) return;

  await fetch(`${GHL_BASE}/opportunities/${opp.id}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({ status: stage })
  });
}
