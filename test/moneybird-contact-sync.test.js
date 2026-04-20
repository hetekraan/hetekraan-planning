import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStructuredAddressFromContact,
  planMoneybirdContactSyncPatch,
} from '../lib/moneybird.js';

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
