// api/create-payment.js
// Wordt aangeroepen wanneer monteur op "Bevestig klaar" klikt.
// 1. Maakt een Mollie betaallink aan
// 2. Genereert een PDF factuur
// 3. Stuurt betaallink via GHL WhatsApp
// 4. Stuurt factuur als PDF bijlage via Resend email

import { createMollieClient } from '@mollie/api-client';
import { generateInvoicePDF, calcInvoiceTotal } from '../lib/invoice.js';
import { fetchWithRetry }     from '../lib/retry.js';
import { sendErrorNotification } from '../lib/notify.js';
import { verifySessionToken } from '../lib/session.js';

const GHL_API_KEY  = process.env.GHL_API_KEY;
const GHL_BASE     = 'https://services.leadconnectorhq.com';
const GHL_HEADERS  = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-04-15',
  'Content-Type': 'application/json',
};

const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

function invoiceNumber() {
  const year = new Date().getFullYear();
  const rand = String(Math.floor(10000 + Math.random() * 90000));
  return `${year}-${rand}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Endpoint mag alleen worden aangeroepen vanuit het ingelogde dashboard.
  const session = verifySessionToken(req.headers['x-hk-auth']);
  if (!session) {
    return res.status(401).json({ error: 'Niet geautoriseerd — log opnieuw in op het dashboard' });
  }

  const {
    contactId,
    contactName,
    contactEmail,
    contactAddress,
    contactCity,
    lines,       // [{ desc, price }]  — prijs incl. BTW
    basePrice,   // basisprijs afspraak (incl. BTW)
    appointmentDesc,
  } = req.body;

  try {
    // ── Regellijst opbouwen ──────────────────────────────────────────────────
    const invoiceLines = [];
    if (basePrice > 0) {
      invoiceLines.push({ desc: appointmentDesc || 'Werkzaamheden', price: basePrice });
    }
    for (const line of (lines || [])) {
      if (line.price > 0) invoiceLines.push(line);
    }

    if (!invoiceLines.length) {
      return res.status(400).json({ error: 'Geen regels opgegeven' });
    }

    const totalInclBTW = calcInvoiceTotal(invoiceLines);
    const invNumber    = invoiceNumber();

    // ── 1. Mollie betaallink ─────────────────────────────────────────────────
    let paymentUrl = null;
    let mollieError = null;
    try {
      const payment = await mollie.payments.create({
        amount: {
          currency: 'EUR',
          value: totalInclBTW.toFixed(2),
        },
        description: `Hetekraan — Factuur ${invNumber}`,
        redirectUrl: process.env.MOLLIE_REDIRECT_URL || 'https://hetekraan.nl',
        metadata: { invoiceNumber: invNumber, contactId },
      });
      paymentUrl = payment.getCheckoutUrl();
      console.log('[create-payment] Mollie link:', paymentUrl);
    } catch (err) {
      mollieError = err.message;
      console.error('[create-payment] Mollie fout:', err.message, err.stack);
      await sendErrorNotification('Mollie betaallink mislukt', err.message);
    }

    // ── 2. PDF factuur genereren ─────────────────────────────────────────────
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateInvoicePDF({
        invoiceNumber: invNumber,
        customer: {
          name:    contactName,
          address: contactAddress,
          city:    contactCity,
          country: 'Nederland',
        },
        lines: invoiceLines,
      });
      console.log('[create-payment] PDF gegenereerd, bytes:', pdfBuffer.length);
    } catch (err) {
      console.error('[create-payment] PDF fout:', err.message);
      await sendErrorNotification('PDF factuur generatie mislukt', err.message);
    }

    // ── 3. Betaallink opslaan op contact + tag zetten voor GHL workflow ────
    if (contactId && paymentUrl) {
      // Sla betaallink + geformatteerde prijs op als custom fields voor het WhatsApp template
      const prijsFormatted = `€${totalInclBTW.toFixed(2).replace('.', ',')} (incl. BTW)`;
      try {
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: GHL_HEADERS,
          body: JSON.stringify({
            customFields: [
              { id: 'wtZj3NPqHc8bFMVUYJMk', field_value: paymentUrl },
              { id: 'HGjlT6ofaBiMz3j2HsXL', field_value: prijsFormatted },
            ]
          })
        });
      } catch {}

      // Sla ook op als notitie (als backup)
      try {
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/notes`, {
          method: 'POST',
          headers: GHL_HEADERS,
          body: JSON.stringify({
            body: `BETAALLINK: ${paymentUrl}\nFactuur: ${invNumber}\nBedrag: €${totalInclBTW.toFixed(2).replace('.', ',')}`,
          })
        });
      } catch {}

      // Verwijder tag eerst (zodat workflow opnieuw triggert bij herhaald gebruik)
      try {
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
          method: 'DELETE',
          headers: GHL_HEADERS,
          body: JSON.stringify({ tags: ['stuur-betaallink'] })
        });
      } catch {}
      await new Promise(r => setTimeout(r, 1000));

      // Zet tag zodat GHL-workflow het WhatsApp template stuurt
      try {
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
          method: 'POST',
          headers: GHL_HEADERS,
          body: JSON.stringify({ tags: ['stuur-betaallink'] })
        });
        console.log('[create-payment] Tag stuur-betaallink gezet');
      } catch (err) {
        console.error('[create-payment] Tag fout:', err.message);
      }
    }

    // ── 4. Factuur per email — later toevoegen ────────────────────────────────

    return res.status(200).json({
      success: true,
      invoiceNumber: invNumber,
      paymentUrl,
      totalInclBTW,
      mollieError: mollieError || undefined,
    });

  } catch (err) {
    console.error('[create-payment] onverwachte fout:', err.message);
    await sendErrorNotification('create-payment onverwachte fout', err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }
}
