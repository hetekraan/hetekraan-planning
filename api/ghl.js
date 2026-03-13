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
        
        // Probeer meerdere varianten en geef alle debug info terug
        const url1 = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${date}T00:00:00Z&endTime=${date}T23:59:59Z`;
        const url2 = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&startTime=${date}T00:00:00Z&endTime=${date}T23:59:59Z`;
        
        const r1 = await fetch(url1, {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
        });
        const d1 = await r1.json();

        const r2 = await fetch(url2, {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
        });
        const d2 = await r2.json();

        return res.status(200).json({ 
          debug: true,
          date,
          locationId: GHL_LOCATION_ID,
          calendarId: GHL_CALENDAR_ID,
          metCalendarId: d1,
          zonderCalendarId: d2,
        });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
