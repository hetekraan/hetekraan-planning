// api/mollie-webhook.js
// Mollie stuurt een POST naar dit endpoint zodra de betalingsstatus wijzigt.
// We verifiëren de betaling direct bij Mollie en updaten dan GHL.

import { createMollieClient } from '@mollie/api-client';
import { pulseContactTag } from '../lib/ghl-tag.js';
import { fetchWithRetry } from '../lib/retry.js';

const mollie   = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_KEY  = process.env.GHL_API_KEY;

export default async function handler(req, res) {
  // Mollie stuurt altijd een POST; andere methoden negeren
  if (req.method !== 'POST') return res.status(200).end();

  const paymentId = req.body?.id || req.query?.id;
  if (!paymentId || typeof paymentId !== 'string') {
    return res.status(200).end(); // altijd 200 terug aan Mollie (anders retry storm)
  }

  try {
    // Verifieer betalingsstatus direct bij Mollie (niet vertrouwen op webhook body)
    const payment = await mollie.payments.get(paymentId);
    const status  = payment.status;
    const contactId = payment.metadata?.contactId;

    console.log(`[mollie-webhook] ${paymentId} → ${status} | contactId: ${contactId}`);

    if (status === 'paid' && contactId) {
      await Promise.all([
        // Tag pulseren → GHL-workflow kan hierop reageren (bijv. bedankje sturen)
        pulseContactTag(contactId, 'betaald', '[mollie-webhook]'),

        // Custom field "Betalingsstatus" bijwerken (maak dit veld aan in GHL als gewenst)
        updateBetalingsstatus(contactId, 'Betaald'),
      ]);

      console.log(`[mollie-webhook] GHL bijgewerkt voor contact ${contactId}`);
    }
  } catch (err) {
    console.error('[mollie-webhook] fout:', err.message);
    // Toch 200 terug zodat Mollie niet blijft retrying
  }

  return res.status(200).end();
}

async function updateBetalingsstatus(contactId, value) {
  if (!GHL_KEY) return;
  try {
    await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GHL_KEY}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15',
      },
      body: JSON.stringify({
        customFields: [{ id: 'xAg0jUYsOL6IZZjdHuRq', field_value: value }], // Betalingsstatus
      }),
    });
  } catch (err) {
    console.warn('[mollie-webhook] betalingsstatus update mislukt:', err.message);
  }
}
