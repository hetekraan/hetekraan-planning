/**
 * Dagelijks financieel overzicht per e-mail naar info@hetekraan.nl.
 *
 * vercel.json: "0 6 * * *" (zelfde tijd als daily-analysis).
 * Beveiliging: CRON_SECRET bearer-token, net als de andere crons.
 *
 * Verzamelt uit Moneybird:
 *   - Crediteuren: openstaande inkoopfacturen met vervaldatum vandaag of eerder.
 *   - Debiteuren (alleen maandag): openstaande verkoopfacturen > 14 dagen te laat.
 *   - Onverwerkte uitgaven: debit-bankmutaties (state:unprocessed) laatste ~60 dagen.
 *   - Inkoopfacturen zonder bijlage (bewaarplicht).
 *   - BTW-aangifte: alleen binnen ~10 dagen vóór de deadline.
 *
 * Verzending: via de GHL Conversations/Email API (lib/email-ghl.js), vanaf het
 * dedicated domein moneybird@rapportage.hetekraan.nl. GHL mailt naar een
 * bestaand contact; het contact voor info@hetekraan.nl wordt op e-mailadres
 * opgezocht (niet automatisch aangemaakt).
 *
 * Handmatig testen zonder te wachten op de crontijd:
 *   ?dryRun=1          → data ophalen + e-mail samenstellen + contactId/from tonen,
 *                        maar NIETS versturen.
 *   ?forceDebiteuren=1 → forceer de maandag-sectie (debiteuren) op een andere dag.
 */

import {
  formatYyyyMmDdInAmsterdam,
  addAmsterdamCalendarDays,
  amsterdamWeekdaySun0,
} from '../../lib/amsterdam-calendar-day.js';
import {
  getOpenPurchaseInvoices,
  getOpenSalesInvoices,
  getUnprocessedDebitMutations,
  getPurchaseInvoicesWithoutAttachment,
} from '../../lib/moneybird-invoices.js';
import { getBtwReminder } from '../../lib/btw-aangifte.js';
import { buildFinanceReportEmail } from '../../lib/finance-report-email.js';
import {
  sendEmailViaGhl,
  findContactIdByEmail,
  describeContactLookupFailure,
  FINANCE_REPORT_FROM,
} from '../../lib/email-ghl.js';

const REPORT_RECIPIENT = 'info@hetekraan.nl';
// Debiteuren-drempel: verkoopfacturen die meer dan dit aantal dagen over de
// vervaldatum heen zijn (startpunt). Makkelijk aan te passen.
const SALES_OVERDUE_DAYS = 14;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.MONEYBIRD_API_TOKEN || !process.env.MONEYBIRD_ADMINISTRATION_ID) {
    return res.status(500).json({
      error: 'Missing env vars: MONEYBIRD_API_TOKEN, MONEYBIRD_ADMINISTRATION_ID',
    });
  }

  const today = formatYyyyMmDdInAmsterdam(new Date());
  if (!today) {
    return res.status(500).json({ error: 'Kon vandaag niet bepalen (tijdzone)' });
  }

  // Testhaakjes (query params):
  //   ?dryRun=1          → alles ophalen + e-mail samenstellen, maar NIET versturen.
  //   ?forceDebiteuren=1 → toon de maandag-sectie ongeacht de weekdag.
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const forceDebiteuren =
    req.query?.forceDebiteuren === '1' || req.query?.forceDebiteuren === 'true';
  const isMonday = amsterdamWeekdaySun0(today) === 1 || forceDebiteuren;

  console.log('[finance-report] start', JSON.stringify({ today, isMonday, dryRun }));

  try {
    // Crediteuren: openstaand + vervaldatum vandaag of gepasseerd.
    const openPurchase = await getOpenPurchaseInvoices({ today });
    const purchaseDue = openPurchase.filter((inv) => inv.dueDate && inv.dueDate <= today);

    // Debiteuren (alleen maandag): > SALES_OVERDUE_DAYS over de vervaldatum.
    let salesOverdue = null;
    if (isMonday) {
      const cutoff = addAmsterdamCalendarDays(today, -SALES_OVERDUE_DAYS);
      const openSales = await getOpenSalesInvoices({ today });
      salesOverdue = openSales.filter((inv) => inv.dueDate && inv.dueDate < cutoff);
    }

    // Onverwerkte uitgaven (elke dag).
    const unprocessed = await getUnprocessedDebitMutations({ today });

    // Facturen zonder bijlage (elke dag).
    const noAttachment = await getPurchaseInvoicesWithoutAttachment({ today });

    // BTW-aangifte (alleen binnen de herinneringswindow).
    const btw = getBtwReminder(today);

    const { subject, html, text } = buildFinanceReportEmail({
      dateStr: today,
      isMonday,
      purchaseDue,
      salesOverdue,
      unprocessed,
      noAttachment,
      btw,
    });

    const counts = {
      teBetalen: purchaseDue.length,
      teHerinneren: isMonday ? (salesOverdue?.length ?? 0) : null,
      onverwerkteUitgaven: unprocessed.length,
      zonderBijlage: noAttachment.length,
      btwHerinnering: Boolean(btw),
    };

    if (dryRun) {
      // Toon welk contactId + from-adres gebruikt zou worden, zodat dit vóór
      // een echte verzending gecontroleerd kan worden. Verstuurt NIETS.
      const lookup = await findContactIdByEmail(REPORT_RECIPIENT);
      const emailPlan = {
        from: FINANCE_REPORT_FROM,
        to: REPORT_RECIPIENT,
        contactId: lookup.ok ? lookup.contactId : null,
        contactResolved: lookup.ok,
        note: lookup.ok
          ? 'Contact gevonden. Echte verzending pas uitvoeren als rapportage.hetekraan.nl in GHL op "Verified" staat.'
          : describeContactLookupFailure(lookup),
      };
      console.log('[finance-report] dryRun, niet verzonden', JSON.stringify({ ...counts, emailPlan }));
      return res
        .status(200)
        .json({ ok: true, dryRun: true, dateStr: today, isMonday, counts, emailPlan, subject, html, text });
    }

    const sent = await sendEmailViaGhl({ toEmail: REPORT_RECIPIENT, subject, html, text });
    console.log(
      '[finance-report] verzonden',
      JSON.stringify({ messageId: sent.messageId, contactId: sent.contactId, from: sent.from, ...counts })
    );

    return res.status(200).json({
      ok: true,
      dateStr: today,
      isMonday,
      counts,
      email: { messageId: sent.messageId, conversationId: sent.conversationId, contactId: sent.contactId, from: sent.from, to: sent.to },
    });
  } catch (err) {
    console.error('[finance-report] fout:', err?.message || String(err));
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
