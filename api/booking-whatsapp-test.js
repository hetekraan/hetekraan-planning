/**
 * Diagnose: POST /api/booking-whatsapp-test
 * Zelfde logica als POST /api/health (als dit bestand op Vercel ontbreekt, gebruik dan health).
 */

import { runWhatsappDebugTest } from '../lib/ghl-whatsapp-debug-test.js';

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b && typeof b === 'object' ? b : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-booking-debug-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.BOOKING_DEBUG_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: 'BOOKING_DEBUG_SECRET staat niet in Vercel — zet een geheime string om dit endpoint te gebruiken.',
    });
  }
  const provided = req.headers['x-booking-debug-secret'];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Ongeldige of ontbrekende x-booking-debug-secret header' });
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: 'Ongeldige JSON body' });
  const contactId = body.contactId;

  const out = await runWhatsappDebugTest(contactId);
  if (out._httpStatus) {
    const { _httpStatus, ...rest } = out;
    return res.status(_httpStatus).json(rest);
  }
  return res.status(200).json(out);
}
