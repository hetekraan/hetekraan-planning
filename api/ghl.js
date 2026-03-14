// api/ghl.js
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

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
            e.contact = cd?.contact || cd;
          } catch(_) {}
          return e;
        }));

        return res.status(200).json({ events: enriched });
      }

      case 'completeAppointment': {
        const { contactId, appointmentId, type, sendReview, lastService } = req.body;
        const today = new Date().toISOString().split('T')[0];
        const fields = { customFields: [] };
        fields.customFields.push({ key: 'laatste_onderhoudsbeurt', field_value: today });
        if (type === 'reparatie' && lastService) {
          fields.customFields.push({ key: 'laatste_onderhoudsbeurt', field_value: lastService });
        }
        if (type === 'installatie') {
          fields.customFields.push({ key: 'datum_installatie', field_value: today });
        }
        await fetch(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify(fields)
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
