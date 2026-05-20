import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStructuredAddressFromContact,
  isMoneybirdEmailDomainUnreachableFailure,
  planMoneybirdContactSyncPatch,
} from '../lib/moneybird.js';
import { hasMoneybirdPlannerInvoiceUrlInNotes } from '../lib/moneybird-planner-invoice-marker.js';

test('create contact: losse postcode en plaats blijven gestructureerd', () => {
  const out = buildStructuredAddressFromContact({
    address1: 'Dorpsstraat 12',
    postalCode: '1985bb',
    city: 'Driehuis',
    country: 'nl',
  });
  assert.equal(out.address1, 'Dorpsstraat 12');
  assert.equal(out.zipcode, '1985 BB');
  assert.equal(out.city, 'Driehuis');
  assert.equal(out.country, 'Netherlands');
});

test('create contact: gecombineerd NL-adres wordt gesplitst', () => {
  const out = buildStructuredAddressFromContact({
    address1: 'Van Den Vondellaan 41, 1985 BB Driehuis',
  });
  assert.equal(out.address1, 'Van Den Vondellaan 41');
  assert.equal(out.zipcode, '1985 BB');
  assert.equal(out.city, 'Driehuis');
  assert.equal(out.country, 'Netherlands');
});

test('bestaand moneybird-contact zonder email krijgt patch met email', () => {
  const existing = {
    email: '',
    phone: '0612340000',
    address1: 'Dorpsstraat 12',
    zipcode: '1985 BB',
    city: 'Driehuis',
  };
  const desired = {
    email: 'Klant@Example.com',
    phone: '0612340000',
    address1: 'Dorpsstraat 12',
    zipcode: '1985 BB',
    city: 'Driehuis',
  };
  const out = planMoneybirdContactSyncPatch(existing, desired);
  assert.equal(out.patch.email, 'klant@example.com');
});

test('bestaand moneybird-contact zonder zipcode/city krijgt betere adrespatch', () => {
  const existing = {
    address1: 'Van Den Vondellaan 41',
    zipcode: '',
    city: '',
  };
  const desired = {
    address1: 'Van Den Vondellaan 41',
    zipcode: '1985 BB',
    city: 'Driehuis',
    country: 'Netherlands',
  };
  const out = planMoneybirdContactSyncPatch(existing, desired);
  assert.equal(out.patch.zipcode, '1985 BB');
  assert.equal(out.patch.city, 'Driehuis');
  assert.equal(out.patch.country, 'Netherlands');
});

test('bedrijfsfactuur met factuur adresvelden normaliseert correct', () => {
  const out = buildStructuredAddressFromContact({
    address1: 'Industrieweg 5',
    postcode: '1507 aa',
    plaats: 'Zaandam',
  });
  assert.equal(out.address1, 'Industrieweg 5');
  assert.equal(out.zipcode, '1507 AA');
  assert.equal(out.city, 'Zaandam');
  assert.equal(out.country, 'Netherlands');
});

test('422 + email_domain_unreachable → contact-create fallbackable', () => {
  assert.equal(
    isMoneybirdEmailDomainUnreachableFailure({
      status: 422,
      message: 'POST /contacts.json (status 422): {"error":"email_domain_unreachable"}',
      details: {},
    }),
    true
  );
});

test('422 + send_invoices_to_email cannot receive → fallbackable', () => {
  assert.equal(
    isMoneybirdEmailDomainUnreachableFailure({
      status: 422,
      message: 'Unprocessable Entity',
      details: { error: 'send_invoices_to_email includes a domain which cannot receive emails' },
    }),
    true
  );
});

test('500 + email_domain_unreachable in tekst → niet fallbackable', () => {
  assert.equal(
    isMoneybirdEmailDomainUnreachableFailure({
      status: 500,
      message: 'email_domain_unreachable',
      details: '',
    }),
    false
  );
});

test('planner: marker + https url op regel → retry-knop predicate true', () => {
  assert.equal(
    hasMoneybirdPlannerInvoiceUrlInNotes('x', '[moneybird] url=https://in.moneybird.com/123 ref=y'),
    true
  );
});

test('planner: alleen url zonder [moneybird] → false', () => {
  assert.equal(hasMoneybirdPlannerInvoiceUrlInNotes('', 'url=https://x.nl/y'), false);
});

test('planner: marker zonder url= → false', () => {
  assert.equal(hasMoneybirdPlannerInvoiceUrlInNotes('[moneybird] ref=1', ''), false);
});

test('particulier met normaal adres blijft bruikbaar zonder parsing', () => {
  const out = buildStructuredAddressFromContact({
    address1: 'Hoofdstraat 1',
    city: 'Haarlem',
  });
  assert.equal(out.address1, 'Hoofdstraat 1');
  assert.equal(out.zipcode, '');
  assert.equal(out.city, 'Haarlem');
  assert.equal(out.country, '');
});
