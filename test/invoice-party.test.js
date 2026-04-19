import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoicePartyFromContact } from '../lib/invoice-party-ghl.js';

test('buildInvoicePartyFromContact particulier without invoice ids', () => {
  const contact = {
    firstName: 'Jan',
    lastName: 'Jansen',
    email: 'jan@example.com',
    phone: '0612345678',
    customFields: [],
  };
  const p = buildInvoicePartyFromContact(contact, {}, { contactId: 'c1' });
  assert.equal(p.invoiceType, 'particulier');
  assert.match(p.displayName, /Jan/);
  assert.equal(p.email, 'jan@example.com');
});

test('buildInvoicePartyFromContact bedrijf via custom field values', () => {
  const idMap = {
    factuur_type: 't1',
    factuur_bedrijfsnaam: 't2',
    factuur_tav: 't3',
    factuur_email: 't4',
    factuur_adres: 't5',
    factuur_postcode: 't6',
    factuur_plaats: 't7',
    factuur_kvk: 't8',
    factuur_btw_nummer: 't9',
    factuur_referentie: 't0',
  };
  const contact = {
    firstName: 'Jan',
    lastName: 'Jansen',
    email: 'jan@example.com',
    phone: '0612345678',
    customFields: [
      { id: 't1', value: 'bedrijf' },
      { id: 't2', field_value: 'Acme BV' },
      { id: 't3', value: 'Jan Jansen' },
      { id: 't4', value: 'boekhouding@acme.nl' },
      { id: 't5', value: 'Industrieweg 1' },
      { id: 't6', value: '1234 AB' },
      { id: 't7', value: 'Utrecht' },
      { id: 't8', value: '12345678' },
      { id: 't9', value: 'NL123456789B01' },
      { id: 't0', value: 'PO-99' },
    ],
  };
  const p = buildInvoicePartyFromContact(contact, idMap, { contactId: 'c1' });
  assert.equal(p.invoiceType, 'bedrijf');
  assert.equal(p.companyName, 'Acme BV');
  assert.equal(p.email, 'boekhouding@acme.nl');
  assert.equal(p.reference, 'PO-99');
});
