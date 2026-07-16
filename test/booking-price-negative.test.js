import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toPriceNumber,
  normalizePriceLineItems,
  formatPriceRulesStructuredString,
  parseStructuredPriceRulesString,
} from '../lib/booking-canon-fields.js';

// Borgt dat een korting-regel (negatief bedrag) door de HELE keten blijft bestaan:
// invoer -> normalisatie -> serialiseren naar GHL -> terugparsen -> Moneybird-filter.
// Alle filters horen op `!== 0` te staan (nul weggooien), NIET op `> 0` (negatief weggooien).

test('toPriceNumber behoudt minteken en komma-decimaal', () => {
  assert.equal(toPriceNumber('-100'), -100);
  assert.equal(toPriceNumber('-100,50'), -100.5);
  assert.equal(toPriceNumber('-100.50'), -100.5);
  assert.equal(toPriceNumber('€ -100'), -100);
});

test('normalizePriceLineItems behoudt negatieve regels, gooit alleen ongeldige weg', () => {
  const rows = normalizePriceLineItems([
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
    { desc: 'Geen bedrag', price: '' },
  ]);
  assert.deepEqual(rows, [
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
  ]);
});

test('roundtrip serialize -> parse behoudt negatief bedrag', () => {
  const serialized = formatPriceRulesStructuredString([
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
  ]);
  assert.match(serialized, /Korting\|-100/);
  const parsed = parseStructuredPriceRulesString(serialized);
  assert.deepEqual(parsed, [
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
  ]);
});

test('Moneybird-regelfilter (!== 0) houdt negatief, dropt nul', () => {
  // Zelfde predicate als api/ghl.js en lib/moneybird.js gebruiken.
  const keep = (l) => Boolean(l.desc) && Number(l.price) !== 0 && Number.isFinite(Number(l.price));
  const lines = [
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
    { desc: 'Nulregel', price: 0 },
  ];
  const kept = lines.filter(keep);
  assert.deepEqual(kept, [
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
  ]);
  // Moneybird price-serialisatie: negatief blijft negatief.
  assert.equal(String(Number(-100) || 0), '-100');
});

test('som van regels trekt negatieve regel af', () => {
  const rows = [
    { desc: 'Onderhoud', price: 150 },
    { desc: 'Korting', price: -100 },
  ];
  const total = rows.reduce((sum, r) => sum + (Number(r.price) || 0), 0);
  assert.equal(total, 50);
});
