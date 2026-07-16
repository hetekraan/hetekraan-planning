import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNlPhone, phoneForGhlDuplicateSearch } from '../lib/ghl-phone.js';

const E164_MOBILE = '+31612345678';

test('normalizeNlPhone: NL mobiel-notaties naar E.164', () => {
  const variants = ['0612345678', '+31612345678', '+31 6 12345678', '06-12345678'];
  for (const raw of variants) {
    assert.equal(normalizeNlPhone(raw), E164_MOBILE, `normalizeNlPhone(${JSON.stringify(raw)})`);
  }
});

test('phoneForGhlDuplicateSearch: zelfde E.164 als normalizeNlPhone (booking duplicate-search)', () => {
  const variants = ['0612345678', '+31612345678', '+31 6 12345678', '06-12345678'];
  for (const raw of variants) {
    assert.equal(
      phoneForGhlDuplicateSearch(raw),
      E164_MOBILE,
      `phoneForGhlDuplicateSearch(${JSON.stringify(raw)})`
    );
  }
});

test('phoneForGhlDuplicateSearch: leeg bij ontbrekende invoer', () => {
  assert.equal(phoneForGhlDuplicateSearch(''), '');
  assert.equal(phoneForGhlDuplicateSearch(null), '');
  assert.equal(phoneForGhlDuplicateSearch('   '), '');
});
