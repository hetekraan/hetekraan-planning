import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMoneybirdInvoicePillUrl } from '../lib/moneybird-invoice-pill-url.js';

test('geen pill-URL zonder [moneybird]-marker', () => {
  assert.equal(extractMoneybirdInvoicePillUrl('url=https://pay.moneybird.com/x'), '');
});

test('geen pill-URL bij marker zonder url=', () => {
  assert.equal(extractMoneybirdInvoicePillUrl('[moneybird] ref=abc'), '');
});

test('pill-URL alleen uit [moneybird]-regel met url=', () => {
  assert.equal(
    extractMoneybirdInvoicePillUrl('notitie\n[moneybird] url=https://pay.example.com/inv1'),
    'https://pay.example.com/inv1'
  );
});

test('strip trailing punctuation van url=', () => {
  assert.equal(
    extractMoneybirdInvoicePillUrl('[moneybird] url=https://pay.example.com/x),'),
    'https://pay.example.com/x'
  );
});
