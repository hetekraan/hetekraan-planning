/**
 * Gedeelde WhatsApp/GHL API-test (gebruikt door /api/health POST en /api/booking-whatsapp-test).
 */
import { fetchWithRetry } from './retry.js';
import { normalizeNlPhone } from './ghl-phone.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

export async function runWhatsappDebugTest(contactId) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

  if (!contactId) {
    return { _httpStatus: 400, error: 'contactId verplicht' };
  }
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    return { _httpStatus: 503, error: 'GHL_API_KEY of GHL_LOCATION_ID ontbreekt in Vercel' };
  }

  const GHL_HDR = () => ({
    Authorization: `Bearer ${GHL_API_KEY}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  });

  async function postMessage(payload) {
    return fetchWithRetry(`${GHL_BASE}/conversations/messages`, {
      method: 'POST',
      headers: GHL_HDR(),
      body: JSON.stringify(payload),
    });
  }

  const cr = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
  });
  if (!cr.ok) {
    const t = await cr.text();
    return {
      _httpStatus: 400,
      error: 'Contact ophalen mislukt',
      status: cr.status,
      detail: t.slice(0, 500),
    };
  }
  const cd = await cr.json();
  const contact = cd?.contact || cd;
  const phoneRaw = contact.phone || '';
  const phoneNorm = normalizeNlPhone(phoneRaw);

  const testMsg =
    '[TEST planning] Als je dit ziet, werkt de WhatsApp-API. Je kunt BOOKING_DEBUG_SECRET weer verwijderen of dit endpoint laten staan.';

  const attempts = [];

  async function trySend(label, payload) {
    const r = await postMessage(payload);
    const txt = r.ok ? '' : await r.text().catch(() => '');
    attempts.push({ label, ok: r.ok, status: r.status, detail: txt.slice(0, 500) });
    return r.ok;
  }

  await trySend('WhatsApp + contactId + message', { type: 'WhatsApp', contactId, message: testMsg });
  if (!attempts[attempts.length - 1]?.ok) {
    await trySend('WhatsApp + contactId + body', { type: 'WhatsApp', contactId, body: testMsg });
  }
  if (!attempts.some((a) => a.ok)) {
    await trySend('WhatsApp + contactId + message + locationId', {
      type: 'WhatsApp',
      contactId,
      message: testMsg,
      locationId: GHL_LOCATION_ID,
    });
  }

  const anyOk = attempts.some((a) => a.ok);

  return {
    ok: anyOk,
    contactId,
    phoneRaw: phoneRaw ? `${String(phoneRaw).slice(0, 4)}…` : null,
    phoneNormalized: phoneNorm ? `${phoneNorm.slice(0, 5)}…` : null,
    phoneLooksValid: phoneNorm.length >= 11,
    attempts,
    hint: anyOk
      ? 'API accepteert het bericht. Geen WhatsApp op telefoon = check Meta/template/24u-venster in GHL.'
      : 'Lees "detail" per poging — vaak: ontbrekende scope, geen WhatsApp-kanaal, of ongeldig nummer.',
  };
}
