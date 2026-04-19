/**
 * Factuur op bedrijf / particulier — leest GHL contact custom fields en bouwt een stabiel model voor Moneybird.
 *
 * GHL (aan te maken als custom fields op contact, keys exact of via resolver):
 * - factuur_type                 (particulier | bedrijf)
 * - factuur_bedrijfsnaam
 * - factuur_tav
 * - factuur_kvk
 * - factuur_btw_nummer
 * - factuur_email
 * - factuur_adres
 * - factuur_postcode
 * - factuur_plaats
 * - factuur_referentie
 *
 * Optioneel env overrides: GHL_FIELD_ID_FACTUUR_TYPE, …_BEDRIJFSNAAM, etc. (zie envKeyForInvoiceField).
 */

import { resolveContactCustomFieldId } from './ghl-custom-fields.js';
import { getCfValue, readCanonicalAddressLine } from './ghl-contact-canonical.js';

export const INVOICE_PARTY_GHL_FIELD_KEYS = [
  'factuur_type',
  'factuur_bedrijfsnaam',
  'factuur_tav',
  'factuur_kvk',
  'factuur_btw_nummer',
  'factuur_email',
  'factuur_adres',
  'factuur_postcode',
  'factuur_plaats',
  'factuur_referentie',
];

function envKeyForInvoiceField(fieldKey) {
  const m = {
    factuur_type: 'GHL_FIELD_ID_FACTUUR_TYPE',
    factuur_bedrijfsnaam: 'GHL_FIELD_ID_FACTUUR_BEDRIJFSNAAM',
    factuur_tav: 'GHL_FIELD_ID_FACTUUR_TAV',
    factuur_kvk: 'GHL_FIELD_ID_FACTUUR_KVK',
    factuur_btw_nummer: 'GHL_FIELD_ID_FACTUUR_BTW_NUMMER',
    factuur_email: 'GHL_FIELD_ID_FACTUUR_EMAIL',
    factuur_adres: 'GHL_FIELD_ID_FACTUUR_ADRES',
    factuur_postcode: 'GHL_FIELD_ID_FACTUUR_POSTCODE',
    factuur_plaats: 'GHL_FIELD_ID_FACTUUR_PLAATS',
    factuur_referentie: 'GHL_FIELD_ID_FACTUUR_REFERENTIE',
  };
  return m[fieldKey] || '';
}

/**
 * Resolveert alle factuur-* veld-ids (zelfde robuuste resolver als Moneybird-velden).
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveInvoicePartyFieldIds({ baseUrl, apiKey, locationId } = {}) {
  const out = {};
  for (const fieldKey of INVOICE_PARTY_GHL_FIELD_KEYS) {
    const envK = envKeyForInvoiceField(fieldKey);
    const id = await resolveContactCustomFieldId({
      baseUrl,
      apiKey,
      locationId,
      fieldKey,
      objectType: 'contact',
      envOverride: envK ? String(process.env[envK] || '').trim() : '',
    });
    if (id) out[fieldKey] = String(id).trim();
  }
  return out;
}

export function readInvoicePartyField(contact, fieldKey, idByKey) {
  const id = idByKey[fieldKey];
  if (!id || !contact) return '';
  return getCfValue(contact, id);
}

function splitAttentionToFirstLast(attention) {
  const t = String(attention || '').replace(/\s+/g, ' ').trim();
  if (!t) return { firstname: '', lastname: '' };
  const parts = t.split(' ');
  if (parts.length === 1) return { firstname: parts[0].slice(0, 60), lastname: '' };
  return { firstname: parts[0].slice(0, 60), lastname: parts.slice(1).join(' ').slice(0, 80) };
}

/**
 * @param {object} contact — GHL contact
 * @param {Record<string, string>} idByKey — fieldKey → custom field id
 * @param {{ contactId?: string, appointmentId?: string }} [logCtx]
 * @returns {{
 *   invoiceType: 'particulier'|'bedrijf',
 *   displayName: string,
 *   companyName: string,
 *   attention: string,
 *   email: string,
 *   phone: string,
 *   address1: string,
 *   postalCode: string,
 *   city: string,
 *   kvk: string,
 *   vatNumber: string,
 *   reference: string
 * }}
 */
export function buildInvoicePartyFromContact(contact, idByKey = {}, logCtx = {}) {
  const read = (k) => readInvoicePartyField(contact, k, idByKey);

  const fn = String(contact?.firstName || '').trim();
  const ln = String(contact?.lastName || '').trim();
  const personDisplay = `${fn} ${ln}`.trim() || String(contact?.name || '').trim() || 'Klant';
  const personEmail = String(contact?.email || '').trim().toLowerCase();
  const personPhone = String(contact?.phone || '').trim();
  const privateAddressLine =
    readCanonicalAddressLine(contact) ||
    [contact?.address1, contact?.postalCode, contact?.city].filter(Boolean).join(' ').trim();

  const typeRaw = read('factuur_type').toLowerCase();
  const wantsCompany = typeRaw === 'bedrijf';
  const companyName = read('factuur_bedrijfsnaam');
  const tav = read('factuur_tav');
  const invEmail = read('factuur_email').toLowerCase();
  const invAddr = read('factuur_adres');
  const invPc = read('factuur_postcode');
  const invCity = read('factuur_plaats');
  const kvk = read('factuur_kvk');
  const vat = read('factuur_btw_nummer');
  const ref = read('factuur_referentie');

  const composedInvoiceLine = [invAddr, invPc, invCity].filter(Boolean).join(', ').trim();

  let invoiceType = 'particulier';
  if (wantsCompany && companyName) {
    invoiceType = 'bedrijf';
  } else if (wantsCompany && !companyName) {
    console.warn(
      '[moneybird] invoice_party_company_invalid_fallback_private',
      JSON.stringify({
        contactId: logCtx.contactId || null,
        appointmentId: logCtx.appointmentId || null,
        invoiceTypeRequested: 'bedrijf',
        hasCompanyName: false,
      })
    );
  }

  const baseLog = {
    contactId: logCtx.contactId || null,
    appointmentId: logCtx.appointmentId || null,
    invoiceType,
    hasCompanyName: Boolean(companyName),
    hasInvoiceEmail: Boolean(invEmail),
    hasInvoiceAddress: Boolean(composedInvoiceLine),
  };

  if (invoiceType === 'bedrijf') {
    const email = invEmail || personEmail;
    const phone = personPhone;
    const attention = tav || personDisplay;
    const postalCode = invPc;
    const city = invCity;
    const address1 = composedInvoiceLine || privateAddressLine || '';

    const out = {
      invoiceType: 'bedrijf',
      displayName: personDisplay,
      companyName,
      attention,
      email,
      phone,
      address1,
      postalCode,
      city,
      kvk,
      vatNumber: vat,
      reference: ref,
    };
    console.info('[moneybird] invoice_party_resolved', JSON.stringify(baseLog));
    console.info('[moneybird] invoice_party_company', JSON.stringify({ ...baseLog, companyNameLen: companyName.length }));
    return out;
  }

  const out = {
    invoiceType: 'particulier',
    displayName: personDisplay,
    companyName: '',
    attention: personDisplay,
    email: personEmail,
    phone: personPhone,
    address1: privateAddressLine || '',
    postalCode: String(contact?.postalCode || '').trim(),
    city: String(contact?.city || '').trim(),
    kvk: '',
    vatNumber: '',
    reference: ref,
  };
  console.info('[moneybird] invoice_party_resolved', JSON.stringify(baseLog));
  console.info('[moneybird] invoice_party_private', JSON.stringify(baseLog));
  return out;
}

/**
 * Korte suffix voor factuuromschrijving / interne context (geen PII-blokken buiten ref).
 */
export function formatMoneybirdInvoiceMetadataSuffix(party) {
  if (!party || party.invoiceType !== 'bedrijf') return '';
  const parts = [];
  if (party.reference) parts.push(`Factuurref ${party.reference}`);
  if (party.kvk) parts.push(`KVK ${party.kvk}`);
  if (party.vatNumber) parts.push(`BTW ${party.vatNumber}`);
  if (!parts.length) return '';
  return ` [zakelijk: ${parts.join(' · ')}]`;
}

/**
 * Voegt factuur-* waarden toe aan een bestaande customFields-array (na resolutie van ids).
 * Alleen keys waarvoor `values[key]` niet undefined is worden geschreven.
 * @param {{ id: string, field_value: string }[]} customFields
 * @param {Record<string, string>} idByKey
 * @param {Record<string, string|undefined>} values camelCase keys matching req.body
 */
export function appendInvoicePartyWritesToCustomFields(customFields, idByKey, values = {}) {
  if (!Array.isArray(customFields) || !values || typeof values !== 'object') return;
  const map = [
    ['factuur_type', values.factuurType],
    ['factuur_bedrijfsnaam', values.factuurBedrijfsnaam],
    ['factuur_tav', values.factuurTav],
    ['factuur_kvk', values.factuurKvk],
    ['factuur_btw_nummer', values.factuurBtwNummer],
    ['factuur_email', values.factuurEmail],
    ['factuur_adres', values.factuurAdres],
    ['factuur_postcode', values.factuurPostcode],
    ['factuur_plaats', values.factuurPlaats],
    ['factuur_referentie', values.factuurReferentie],
  ];
  for (const [key, val] of map) {
    if (val === undefined || val === null) continue;
    const id = idByKey[key];
    if (!id) continue;
    const s = String(val).trim();
    customFields.push({ id, field_value: s });
  }
}
