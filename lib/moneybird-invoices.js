/**
 * Moneybird helpers voor het dagelijks financieel overzicht.
 *
 * Hergebruikt de bestaande mbRequest uit lib/moneybird.js (die MB_BASE +
 * administration_id + auth + timeout afhandelt) en de tijdzone-correcte
 * kalenderdaglogica uit lib/amsterdam-calendar-day.js.
 *
 * Filter-syntax gecontroleerd tegen developer.moneybird.com:
 *  - GET /documents/purchase_invoices : filter=state:...,period:...,attachment:...
 *  - GET /sales_invoices              : filter=state:...,period:...
 *  - GET /financial_mutations         : filter=period:YYYYMMDD..YYYYMMDD,state:...,mutation_type:...
 * Meerdere states scheiden met een pipe (bijv. state:open|late).
 */

import { mbRequest } from './moneybird.js';
import {
  formatYyyyMmDdInAmsterdam,
  addAmsterdamCalendarDays,
} from './amsterdam-calendar-day.js';

const MB_ADMIN = process.env.MONEYBIRD_ADMINISTRATION_ID;

// Rollend venster (dagen) voor onverwerkte bankmutaties.
export const UNPROCESSED_MUTATION_LOOKBACK_DAYS = 60;
// Rollend venster (dagen) voor de check "inkoopfacturen zonder bijlage".
export const NO_ATTACHMENT_LOOKBACK_DAYS = 90;
// Rollend venster (dagen) voor het ophalen van openstaande facturen.
// Ruim genoeg om oude, nog niet betaalde facturen mee te nemen.
export const OPEN_INVOICE_LOOKBACK_DAYS = 400;

// "Openstaand" bestrijkt in Moneybird meerdere states, niet alleen `open`.
// Alleen op `open` filteren zou juist de te-late (`late`) facturen missen.
const OPEN_PURCHASE_STATES = 'open|late|pending_payment';
const OPEN_SALES_STATES = 'open|late|reminded|pending_payment';

function moneybirdUiBase() {
  return `https://moneybird.com/${MB_ADMIN}`;
}

function todayStrOrNow(today) {
  return today || formatYyyyMmDdInAmsterdam(new Date());
}

/** '2025-05-01' -> '20250501' (Moneybird custom period-notatie). */
function ymdCompact(dateStr) {
  return String(dateStr || '').replace(/-/g, '');
}

/** Rollend period-filter van (vandaag - lookback) t/m vandaag. */
function rollingPeriod(todayStr, lookbackDays) {
  const from = addAmsterdamCalendarDays(todayStr, -Math.abs(lookbackDays));
  return `${ymdCompact(from)}..${ymdCompact(todayStr)}`;
}

function contactDisplayName(contact) {
  if (!contact || typeof contact !== 'object') return 'Onbekend';
  const company = String(contact.company_name || '').trim();
  const person = [contact.firstname, contact.lastname]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');
  return company || person || 'Onbekend';
}

/** Moneybird bedragen zijn strings (bijv. "121.0" of soms met komma). */
function toAmount(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Paginerend ophalen. Moneybird lijst-endpoints geven max 100 per pagina.
 * We stoppen zodra een pagina < perPage teruggeeft of maxPages is bereikt.
 */
async function mbGetPaged(basePath, filter, { maxPages = 20, perPage = 100 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const parts = [];
    if (filter) parts.push(`filter=${encodeURIComponent(filter)}`);
    parts.push(`per_page=${perPage}`);
    parts.push(`page=${page}`);
    const data = await mbRequest(`${basePath}?${parts.join('&')}`, { method: 'GET' });
    const list = Array.isArray(data) ? data : [];
    out.push(...list);
    if (list.length < perPage) break;
  }
  return out;
}

function mapPurchaseInvoice(inv) {
  const id = String(inv?.id ?? '');
  return {
    id,
    supplier: contactDisplayName(inv?.contact),
    reference: String(inv?.reference || '').trim(),
    amount: toAmount(inv?.total_price_incl_tax),
    dueDate: inv?.due_date || null,
    state: inv?.state || null,
    attachmentsCount: Array.isArray(inv?.attachments) ? inv.attachments.length : 0,
    url: `${moneybirdUiBase()}/documents/${id}`,
  };
}

function mapSalesInvoice(inv) {
  const id = String(inv?.id ?? '');
  const unpaid = toAmount(inv?.total_unpaid);
  return {
    id,
    customer: contactDisplayName(inv?.contact),
    reference: String(inv?.reference || '').trim(),
    amount: unpaid > 0 ? unpaid : toAmount(inv?.total_price_incl_tax),
    dueDate: inv?.due_date || null,
    state: inv?.state || null,
    url: String(inv?.url || '').trim() || `${moneybirdUiBase()}/sales_invoices/${id}`,
  };
}

/**
 * Openstaande inkoopfacturen (crediteuren): states open|late|pending_payment.
 * Geeft per factuur leverancier, factuurnummer, bedrag, vervaldatum en link.
 */
export async function getOpenPurchaseInvoices({ today } = {}) {
  const todayStr = todayStrOrNow(today);
  const filter = `state:${OPEN_PURCHASE_STATES},period:${rollingPeriod(todayStr, OPEN_INVOICE_LOOKBACK_DAYS)}`;
  const list = await mbGetPaged('/documents/purchase_invoices.json', filter);
  return list.map(mapPurchaseInvoice);
}

/**
 * Openstaande verkoopfacturen (debiteuren): states open|late|reminded|pending_payment.
 * Geeft per factuur klant, factuurnummer, (open) bedrag, vervaldatum en link.
 */
export async function getOpenSalesInvoices({ today } = {}) {
  const todayStr = todayStrOrNow(today);
  const filter = `state:${OPEN_SALES_STATES},period:${rollingPeriod(todayStr, OPEN_INVOICE_LOOKBACK_DAYS)}`;
  const list = await mbGetPaged('/sales_invoices.json', filter);
  return list.map(mapSalesInvoice);
}

/**
 * Onverwerkte uitgaven: bankmutaties state:unprocessed, mutation_type:debit,
 * over een rollend venster van ~lookbackDays. Dit zijn betalingen die nog aan
 * niets gekoppeld zijn (geen factuur/bon/categorie).
 */
export async function getUnprocessedDebitMutations({
  today,
  lookbackDays = UNPROCESSED_MUTATION_LOOKBACK_DAYS,
} = {}) {
  const todayStr = todayStrOrNow(today);
  const filter = `period:${rollingPeriod(todayStr, lookbackDays)},state:unprocessed,mutation_type:debit`;
  const list = await mbGetPaged('/financial_mutations.json', filter);
  return list.map((m) => {
    const id = String(m?.id ?? '');
    return {
      id,
      date: m?.date || null,
      counterparty: String(m?.contra_account_name || '').trim() || 'Onbekend',
      amount: Math.abs(toAmount(m?.amount)),
      url: `${moneybirdUiBase()}/financial_mutations/${id}`,
    };
  });
}

/**
 * Inkoopfacturen zonder bijlage — nodig voor de bewaarplicht (Belastingdienst):
 * bij btw-aftrek moet het originele document bewaard blijven, niet alleen het
 * boekhoudkundige record. Moneybird kent een `attachment:without`-filter, maar
 * we filteren hier bewust client-side op een lege attachments-array
 * (attachments.length === 0), zoals gevraagd.
 */
export async function getPurchaseInvoicesWithoutAttachment({
  today,
  lookbackDays = NO_ATTACHMENT_LOOKBACK_DAYS,
} = {}) {
  const todayStr = todayStrOrNow(today);
  const filter = `period:${rollingPeriod(todayStr, lookbackDays)}`;
  const list = await mbGetPaged('/documents/purchase_invoices.json', filter);
  return list
    .map(mapPurchaseInvoice)
    .filter((inv) => inv.attachmentsCount === 0);
}
