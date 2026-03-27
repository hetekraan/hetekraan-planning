/**
 * Server-side sessie-tokens voor het dashboard.
 *
 * Token-formaat: base64url(user|day).hmac-sha256
 * - Geldig voor één Amsterdam-kalenderdag (same-day expiry).
 * - Geheime sleutel: env SESSION_SECRET (vereist in productie).
 * - Gebruikers: env HK_USERS formaat "daan:wachtwoord,jerry:wachtwoord2"
 *
 * Stel in Vercel in:
 *   SESSION_SECRET = <willekeurige lange string>
 *   HK_USERS       = daan:jouwwachtwoord,jerry:anderwachtwoord
 */

import { createHmac, timingSafeEqual } from 'crypto';

const SESSION_SECRET =
  process.env.SESSION_SECRET || 'dev-only-change-in-production-please';

if (!process.env.SESSION_SECRET) {
  console.warn('[session] SESSION_SECRET ontbreekt — gebruik alleen in development!');
}

/** Maak een ondertekend sessie-token. */
export function signSessionToken(user, day) {
  const payload = `${user}|${day}`;
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

/**
 * Verifieer token. Geeft `{ user, day }` terug bij geldig token, anders `null`.
 * Gebruik timing-safe vergelijking om timing-aanvallen te voorkomen.
 */
export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx < 1) return null;
  const b64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  let payload;
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = payload.split('|');
  if (parts.length !== 2) return null;
  const [user, day] = parts;
  if (!user || !day) return null;

  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || sigBuf.length === 0) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }
  return { user, day };
}

// ─── Booking tokens ──────────────────────────────────────────────────────────
//
// Formaat: base64url(JSON.stringify(bookingData)).hmac-sha256-hex
// base64url bevat uitsluitend [A-Za-z0-9-_] — de punt als scheidingsteken is veilig.
//
// Backward-compat: als het token géén punt bevat, wordt het als ongesigneerd (oud)
// beschouwd en afgewezen. Klant ontvangt dan een foutmelding en neemt contact op.

/**
 * Maak een HMAC-gesigneerd boekingstoken.
 * @param {object} data - de boekingsgegevens (contactId, slots, enz.)
 * @returns {string} token in formaat `payload.sig`
 */
export function signBookingToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verifieer een boekingstoken en geef de payload terug, of null als ongeldig.
 * Ongesigneerde tokens (geen punt) worden afgewezen voor veiligheid.
 */
export function verifyBookingToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx < 1) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!payload || !sig) return null;

  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || sigBuf.length === 0) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lees gebruikers uit env var HK_USERS.
 * Formaat: "gebruiker1:wachtwoord1,gebruiker2:wachtwoord2"
 * Bevat een dev-fallback zodat de app ook werkt als HK_USERS nog niet is ingesteld.
 */
export function parseUsers() {
  const raw = process.env.HK_USERS || '';
  const users = {};
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 1) continue;
    const u = pair.slice(0, colonIdx).trim().toLowerCase();
    const p = pair.slice(colonIdx + 1).trim();
    if (u && p) users[u] = p;
  }
  return users;
}
