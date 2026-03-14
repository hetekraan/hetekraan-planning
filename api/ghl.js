// api/ghl.js - debug versie met timestamps in ms
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_USER_ID     = 'VHbv9VzNnzAXgudbG318';
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
        
        // Tijden als Unix timestamps in milliseconds
        const startMs = new Date(`${date}T00:00:00+01:00`).getTime();
        const endMs   = new Date(`${date}T23:59:59+01:00`).getTime();

        // Probeer 3 varianten
        const urls = [
          `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&userId=${GHL_USER_ID}&startTime=${startMs}&endTime=${endMs}`,
          `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`,
          `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&userId=${GHL_USER_ID}&startTime=${startMs}&endTime=${endMs}`,
        ];

        const results = await Promise.all(urls.map(async (url, i) => {
          const r = await fetch(url, {
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
          });
          const d = await r.json();
          return { variant: i+1, url, result: d };
        }));

        return res.status(200).json({ debug: true, startMs, endMs, results });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
