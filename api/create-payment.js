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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET /api/create-payment?id=tr_xxx  →  redirect naar Mollie checkout ──
  // Wordt gebruikt als WhatsApp CTA-button URL zodat er een vaste domeinnaam
  // (hetekraan-planning.vercel.app) als prefix gebruikt kan worden.
  if (req.method === 'GET') {
    const paymentId = req.query?.id;
    if (!paymentId || typeof paymentId !== 'string') {
      return res.status(400).send('Ontbrekend betaal-ID');
    }
    try {
      const payment = await mollie.payments.get(paymentId);
      const checkoutUrl = payment.getCheckoutUrl();
      if (!checkoutUrl) return res.status(404).send('Betaallink niet beschikbaar');
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, checkoutUrl);
    } catch (err) {
      console.error('[create-payment] redirect fout:', err.message);
      return res.status(404).send('Betaling niet gevonden of verlopen');
    }
  }

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
    let molliePaymentId = null; // tr_XXXXX — wordt opgeslagen in GHL-veld voor WhatsApp template
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
      molliePaymentId = payment.id;
      console.log('[create-payment] Mollie link:', paymentUrl, '| id:', molliePaymentId);
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
    const ghlDiag = { fieldsPut: false, noteAdded: false, tagSet: false, tagError: null };

    if (contactId && paymentUrl) {
      const prijsFormatted = `€${totalInclBTW.toFixed(2).replace('.', ',')} (incl. BTW)`;

      try {
        // Sla het Mollie transactie-ID op (tr_XXXXX).
        // De WhatsApp CTA-button wijst naar /api/create-payment?id=tr_XXXXX op onze
        // eigen Vercel-domeinnaam — die doet een live redirect naar de juiste Mollie URL.
        // Zo werkt de button ook als Mollie het pad wijzigt (pay/ vs select-method/).
        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: GHL_HEADERS,
          body: JSON.stringify({
            customFields: [
              { id: 'wtZj3NPqHc8bFMVUYJMk', field_value: molliePaymentId },
              { id: 'HGjlT6ofaBiMz3j2HsXL', field_value: prijsFormatted },
            ]
          })
        });
        ghlDiag.fieldsPut = putRes.ok;
        if (!putRes.ok) {
          const t = await putRes.text().catch(() => '');
          console.error('[create-payment] GHL custom fields PUT:', putRes.status, t.slice(0, 300));
        }
      } catch (err) {
        console.error('[create-payment] GHL PUT fout:', err.message);
      }

      try {
        const noteRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/notes`, {
          method: 'POST',
          headers: GHL_HEADERS,
          body: JSON.stringify({
            body: `BETAALLINK: ${paymentUrl}\nFactuur: ${invNumber}\nBedrag: €${totalInclBTW.toFixed(2).replace('.', ',')}`,
          })
        });
        ghlDiag.noteAdded = noteRes.ok;
      } catch {}

      // Verwijder tag eerst (zodat workflow opnieuw triggert bij herhaald gebruik)
      try {
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
          method: 'DELETE',
          headers: GHL_HEADERS,
          body: JSON.stringify({ tags: ['stuur-betaallink'] })
        });
      } catch {}
      await new Promise(r => setTimeout(r, 1500));

      try {
        const tagRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
          method: 'POST',
          headers: GHL_HEADERS,
          body: JSON.stringify({ tags: ['stuur-betaallink'] })
        });
        ghlDiag.tagSet = tagRes.ok;
        if (!tagRes.ok) {
          const t = await tagRes.text().catch(() => '');
          ghlDiag.tagError = `${tagRes.status}: ${t.slice(0, 200)}`;
          console.error('[create-payment] Tag stuur-betaallink fout:', tagRes.status, t.slice(0, 300));
          await sendErrorNotification('create-payment: GHL tag stuur-betaallink mislukt', ghlDiag.tagError);
        } else {
          console.log('[create-payment] Tag stuur-betaallink gezet ✓');
        }
      } catch (err) {
        ghlDiag.tagError = err.message;
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
      ghlDiag,
    });

  } catch (err) {
    console.error('[create-payment] onverwachte fout:', err.message);
    await sendErrorNotification('create-payment onverwachte fout', err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }
}
