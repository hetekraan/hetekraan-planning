import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPlainEmail,
  normalizeCanonicalGhlEmail,
  readGhlDuplicateSearchContactId,
} from '../lib/ghl-contact-canonical.js';

test('isValidPlainEmail accepts common addresses', () => {
  assert.equal(isValidPlainEmail('  A@B.CC  '), true);
  assert.equal(normalizeCanonicalGhlEmail('  A@B.CC  '), 'a@b.cc');
  assert.equal(isValidPlainEmail(''), false);
  assert.equal(isValidPlainEmail('geen-at'), false);
});

test('readGhlDuplicateSearchContactId handles GHL response variants', () => {
  assert.equal(readGhlDuplicateSearchContactId({ contact: { id: 'abc' } }), 'abc');
  assert.equal(readGhlDuplicateSearchContactId({ id: 'top' }), 'top');
  assert.equal(readGhlDuplicateSearchContactId({ data: { contact: { id: 99 } } }), '99');
  assert.equal(readGhlDuplicateSearchContactId(null), null);
});
