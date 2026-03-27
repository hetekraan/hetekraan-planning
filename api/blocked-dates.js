// api/blocked-dates.js
// GET — geeft de server-side geblokkeerde datums terug (uit BLOCKED_DATES env var).
// Publiek leesbaar; schrijven gaat via Vercel env var (geen write endpoint nodig).

import { getServerBlockedDates } from '../lib/blocked-dates.js';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const dates = [...getServerBlockedDates()].sort();
  return res.status(200).json({ blockedDates: dates });
}
