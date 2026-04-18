import { getMoneybirdPayTokenMapping } from '../../lib/moneybird-pay-token-store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const token = String(req.query?.token || '').trim();
  if (!token) return res.status(404).send('Niet gevonden');

  try {
    const mapping = await getMoneybirdPayTokenMapping(token);
    const invoiceUrl = String(mapping?.invoiceUrl || '').trim();
    if (!mapping || !invoiceUrl) {
      console.info('[moneybird] invoice_redirect_not_found', {
        token,
      });
      return res.status(404).send('Niet gevonden');
    }

    console.info('[moneybird] invoice_redirect_hit', {
      token,
      contactId: String(mapping.contactId || '').trim() || undefined,
      appointmentId: String(mapping.appointmentId || '').trim() || undefined,
      invoiceId: String(mapping.invoiceId || '').trim() || undefined,
      reference: String(mapping.reference || '').trim() || undefined,
    });

    return res.redirect(302, invoiceUrl);
  } catch (e) {
    console.error('[moneybird] invoice_redirect_error', {
      token,
      message: e?.message || String(e),
    });
    return res.status(404).send('Niet gevonden');
  }
}
