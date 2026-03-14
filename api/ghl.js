// api/ghl.js - met debug contact info
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

        // Haal contact op voor eerste afspraak als debug
        const firstWithContact = events.find(e => e.contactId);
        let debugContact = null;
        if (firstWithContact) {
          const cr = await fetch(`${GHL_BASE}/contacts/${firstWithContact.contactId}`, {
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
          });
          debugContact = await cr.json();
        }

        return res.status(200).json({ 
          debug: true,
          firstEvent: events[0],
          contactData: debugContact
        });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
