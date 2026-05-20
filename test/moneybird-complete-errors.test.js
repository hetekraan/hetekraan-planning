import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moneybirdContactCreateFailureResult,
  moneybirdExceptionResult,
  userFacingMoneybirdErrorMessage,
} from '../lib/moneybird-complete-errors.js';

test('email_domain_unreachable → vaste NL-boodschap', () => {
  const msg = userFacingMoneybirdErrorMessage(
    'Moneybird request failed: POST /contacts.json (status 422): {"error":"email_domain_unreachable"}'
  );
  assert.match(msg, /Email-adres van klant/);
  assert.match(msg, /GHL/);
});

test('moneybirdExceptionResult markeert error en reason', () => {
  const r = moneybirdExceptionResult({
    message: 'fail',
    status: 503,
    details: { x: 1 },
  });
  assert.equal(r.skipped, false);
  assert.equal(r.error, true);
  assert.equal(r.reason, 'moneybird_exception');
  assert.equal(r.errorCode, 503);
  assert.ok(typeof r.errorMessage === 'string' && r.errorMessage.length > 0);
});

test('moneybirdContactCreateFailureResult voor contact-create 422', () => {
  const r = moneybirdContactCreateFailureResult({
    reason: 'moneybird_contact_create_failed',
    errorStatus: 422,
    errorMessage: 'email_domain_unreachable in send_invoices_to_email',
    errorDetails: '{"error":"email_domain_unreachable"}',
  });
  assert.equal(r.error, true);
  assert.equal(r.reason, 'moneybird_contact_create_failed');
  assert.equal(r.errorCode, 422);
  assert.match(r.errorMessage, /Email-adres van klant/);
});
