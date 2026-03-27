// api/auth.js — dashboard login
// POST { user, password } → { token, user, day }
//
// Vereiste env vars (instellen in Vercel → Settings → Environment Variables):
//   SESSION_SECRET  — willekeurige lange string, bijv. via `openssl rand -hex 32`
//   HK_USERS        — "daan:wachtwoord1,jerry:wachtwoord2"

import { signSessionToken, parseUsers } from '../lib/session.js';
import { formatYyyyMmDdInAmsterdam } from '../lib/amsterdam-calendar-day.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const u = String(body.user || '').trim().toLowerCase();
  const p = String(body.password || '');

  // Kleine vertraging bij alle login-pogingen om brute-force te bemoeilijken.
  await new Promise((r) => setTimeout(r, 300));

  const users = parseUsers();
  if (!u || !users[u] || users[u] !== p) {
    return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
  }

  const day = formatYyyyMmDdInAmsterdam(new Date());
  if (!day) return res.status(500).json({ error: 'Tijdzone-fout bij token aanmaken' });

  const token = signSessionToken(u, day);
  return res.status(200).json({ token, user: u, day });
}
