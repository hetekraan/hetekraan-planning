/**
 * E-mail versturen via de GHL (HighLevel) Conversations/Email API.
 *
 * Endpoint (geverifieerd tegen marketplace.gohighlevel.com / HighLevel API-docs):
 *   POST https://services.leadconnectorhq.com/conversations/messages
 *   Headers: Authorization: Bearer <GHL_API_KEY>, Version: 2021-04-15, Content-Type: application/json
 *   Body (email): { type: "Email", contactId, subject, html, message, emailFrom, emailTo }
 *     - type + contactId zijn verplicht.
 *     - emailFrom = afzender (op de outbound send-endpoint per bericht instelbaar,
 *       mits op een in GHL geverifieerd/geautoriseerd verzenddomein).
 *     - message = platte-tekst-variant, html = HTML-variant.
 *
 * Contact opzoeken (verplicht — GHL mailt naar een contactId, niet los adres):
 *   GET https://services.leadconnectorhq.com/contacts/?locationId=..&query=<email>&limit=..
 *
 * Ditzelfde patroon (contact zoeken + POST /conversations/messages met emailFrom
 * op een eigen domein) wordt al gebruikt in lib/notify.js.
 *
 * BELANGRIJK — verzenddomein:
 *   Het afzenderdomein (rapportage.hetekraan.nl) moet in GHL als Dedicated Sending
 *   Domain geverifieerd zijn (Settings → Email Services → Dedicated Domain).
 *   Zolang dat domein niet op "Verified" staat, weigert GHL het versturen vanaf
 *   moneybird@rapportage.hetekraan.nl.
 */

import { ghlLocationIdFromEnv } from './ghl-env-ids.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';

// Vast afzenderadres voor het financieel rapport (nieuw dedicated domein,
// los van reply.hetekraan.nl dat voor klantmail wordt gebruikt).
export const FINANCE_REPORT_FROM = 'moneybird@rapportage.hetekraan.nl';

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * Zoekt een BESTAAND GHL-contact op e-mailadres. Maakt bewust niets aan:
 * bij geen match geeft het { ok:false, reason:'contact_not_found' } terug,
 * zodat de aanroeper zelf kan beslissen (handmatig contact aanmaken / adres
 * corrigeren) in plaats van dat we een dubbel contact creëren.
 *
 * @param {string} email
 * @returns {Promise<{ ok: boolean, contactId?: string, email: string, reason?: string, status?: number, detail?: string }>}
 */
export async function findContactIdByEmail(email) {
  const target = normEmail(email);
  if (!process.env.GHL_API_KEY) {
    return { ok: false, email: target, reason: 'missing_api_key' };
  }
  const locationId = ghlLocationIdFromEnv();
  if (!locationId) {
    return { ok: false, email: target, reason: 'missing_location_id' };
  }
  if (!target) {
    return { ok: false, email: target, reason: 'missing_email' };
  }

  const url =
    `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}` +
    `&query=${encodeURIComponent(target)}&limit=20`;
  const res = await fetch(url, { headers: ghlHeaders() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      ok: false,
      email: target,
      reason: 'contacts_api_error',
      status: res.status,
      detail: detail.slice(0, 500),
    };
  }
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data?.contacts) ? data.contacts : [];
  const match = list.find((c) => normEmail(c?.email) === target) || null;
  if (!match?.id) {
    return { ok: false, email: target, reason: 'contact_not_found' };
  }
  return { ok: true, contactId: String(match.id), email: target };
}

/**
 * Verstuurt een e-mail via GHL naar een bestaand contact (op e-mailadres).
 * Gooit een duidelijke fout als het contact niet bestaat of GHL het bericht weigert.
 *
 * @param {{ toEmail: string, subject: string, html: string, text?: string, from?: string }} params
 * @returns {Promise<{ messageId: string|null, conversationId: string|null, contactId: string, from: string, to: string }>}
 */
export async function sendEmailViaGhl({ toEmail, subject, html, text, from = FINANCE_REPORT_FROM } = {}) {
  if (!subject) throw new Error('Onderwerp (subject) ontbreekt');
  if (!html) throw new Error('HTML-inhoud (html) ontbreekt');

  const found = await findContactIdByEmail(toEmail);
  if (!found.ok) {
    throw new Error(describeContactLookupFailure(found));
  }

  const body = {
    type: 'Email',
    contactId: found.contactId,
    subject,
    html,
    emailFrom: from,
    emailTo: found.email,
  };
  if (text) body.message = text;

  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: 'POST',
    headers: ghlHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(
      `GHL e-mail versturen mislukt (status ${res.status}). ` +
        `Controleer of ${from} op een geverifieerd Dedicated Sending Domain zit. ` +
        `Antwoord: ${detail.slice(0, 500)}`
    );
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  return {
    messageId: data?.messageId || data?.id || null,
    conversationId: data?.conversationId || null,
    contactId: found.contactId,
    from,
    to: found.email,
  };
}

/** Leesbare foutmelding bij het niet kunnen vinden van het contact. */
export function describeContactLookupFailure(found) {
  const email = found?.email || '(onbekend)';
  switch (found?.reason) {
    case 'missing_api_key':
      return 'GHL_API_KEY ontbreekt.';
    case 'missing_location_id':
      return 'GHL_LOCATION_ID ontbreekt.';
    case 'missing_email':
      return 'Geen ontvanger-e-mailadres opgegeven.';
    case 'contacts_api_error':
      return `GHL Contacts API-fout (status ${found.status}) bij zoeken op ${email}: ${found.detail || ''}`;
    case 'contact_not_found':
      return (
        `Geen GHL-contact gevonden voor ${email}. ` +
        `Maak dit contact eerst handmatig aan in GHL (of geef het juiste e-mailadres door) — ` +
        `er wordt bewust geen nieuw contact aangemaakt.`
      );
    default:
      return `Kon GHL-contact voor ${email} niet bepalen.`;
  }
}
