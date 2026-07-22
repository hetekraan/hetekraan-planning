import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategorie, CANONICAL_CATEGORIES } from '../lib/prices-store.js';

test('normalizeCategorie mapt bekende varianten naar canonieke waarden', () => {
  assert.equal(normalizeCategorie('quooker'), 'Quookers');
  assert.equal(normalizeCategorie('kraan'), 'Kranen');
  assert.equal(normalizeCategorie('service'), 'Serviceproducten');
  assert.equal(normalizeCategorie('diensten'), 'Diensten');
  assert.equal(normalizeCategorie('dienst'), 'Diensten');
});

test('normalizeCategorie laat canonieke waarden ongemoeid', () => {
  for (const c of CANONICAL_CATEGORIES) {
    assert.equal(normalizeCategorie(c), c);
  }
});

test('normalizeCategorie is ongevoelig voor hoofdletters en spaties', () => {
  assert.equal(normalizeCategorie('  QUOOKER '), 'Quookers');
  assert.equal(normalizeCategorie('Service Producten'), 'Serviceproducten');
  assert.equal(normalizeCategorie('serviceproducten'), 'Serviceproducten');
});

test('lege categorie valt terug op Serviceproducten', () => {
  assert.equal(normalizeCategorie(''), 'Serviceproducten');
  assert.equal(normalizeCategorie(null), 'Serviceproducten');
  assert.equal(normalizeCategorie(undefined), 'Serviceproducten');
});

test('onbekende categorie blijft ongewijzigd (niet stil gedropt)', () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(normalizeCategorie('Onderdelen'), 'Onderdelen');
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1);
});
