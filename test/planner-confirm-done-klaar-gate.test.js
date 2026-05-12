import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

// Gate script expects browser-like global
globalThis.window = globalThis;
require('../public/app/planner-confirm-done-klaar-gate.js');

const gate = globalThis.HKPlannerConfirmDoneGate;
assert.ok(gate, 'HKPlannerConfirmDoneGate moet geladen zijn');

test('shouldMarkKlaarLocally: simulate ghlRes.ok = false', () => {
  assert.equal(
    gate.shouldMarkKlaarLocally({ hasContactId: true, ghlResponseOk: false, fetchErrored: false }),
    false
  );
});

test('shouldMarkKlaarLocally: simulate fetch throw path (fetchErrored true)', () => {
  assert.equal(
    gate.shouldMarkKlaarLocally({ hasContactId: true, ghlResponseOk: true, fetchErrored: true }),
    false
  );
});

test('shouldMarkKlaarLocally: no contactId', () => {
  assert.equal(
    gate.shouldMarkKlaarLocally({ hasContactId: false, ghlResponseOk: true, fetchErrored: false }),
    false
  );
});

test('shouldMarkKlaarLocally: simulate success', () => {
  assert.equal(
    gate.shouldMarkKlaarLocally({ hasContactId: true, ghlResponseOk: true, fetchErrored: false }),
    true
  );
});

test('moneybirdSkippedUserMessage: no_billable_lines', () => {
  const msg = gate.moneybirdSkippedUserMessage({ skipped: true, reason: 'no_billable_lines' });
  assert.match(msg, /geen factureerbare regels/i);
});

test('moneybirdSkippedUserMessage: missing_contact', () => {
  const msg = gate.moneybirdSkippedUserMessage({ skipped: true, reason: 'missing_contact' });
  assert.match(msg, /Moneybird/i);
});

test('moneybirdSkippedUserMessage: invoice_not_created', () => {
  const msg = gate.moneybirdSkippedUserMessage({ skipped: true, reason: 'invoice_not_created' });
  assert.match(msg, /niet aangemaakt/i);
});

test('moneybirdSkippedUserMessage: not skipped returns null', () => {
  assert.equal(gate.moneybirdSkippedUserMessage({ skipped: false }), null);
  assert.equal(gate.moneybirdSkippedUserMessage(null), null);
});
