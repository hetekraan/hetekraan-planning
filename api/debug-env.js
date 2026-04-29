export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  return res.status(200).json({
    GHL_API_KEY: Boolean(process.env.GHL_API_KEY),
    GHL_LOCATION_ID: Boolean(process.env.GHL_LOCATION_ID),
    GHL_CALENDAR_ID: Boolean(process.env.GHL_CALENDAR_ID),
    NODE_ENV: process.env.NODE_ENV || '',
    VERCEL_ENV: process.env.VERCEL_ENV || '',
  });
}
