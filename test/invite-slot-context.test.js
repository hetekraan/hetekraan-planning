import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInviteWorkType, resolveInviteAddress } from '../lib/invite-slot-context.js';

// ── workType ────────────────────────────────────────────────────────────────

test('resolveInviteWorkType: formulier wint van GHL', () => {
  assert.equal(
    resolveInviteWorkType({ typeParam: 'installatie', contactTypeField: 'onderhoud' }),
    'installatie'
  );
});

test('resolveInviteWorkType: workTypeParam wint van typeParam', () => {
  assert.equal(
    resolveInviteWorkType({ typeParam: 'onderhoud', workTypeParam: 'reparatie' }),
    'reparatie'
  );
});

test('resolveInviteWorkType: valt terug op GHL als formulier leeg', () => {
  assert.equal(
    resolveInviteWorkType({ typeParam: '', workTypeParam: '', contactTypeField: 'installatie' }),
    'installatie'
  );
  assert.equal(
    resolveInviteWorkType({ contactTypeField: 'herafspraak' }),
    'herafspraak'
  );
});

test('resolveInviteWorkType: leeg formulier + leeg GHL → reparatie (geen stille onderhoud-default)', () => {
  assert.equal(resolveInviteWorkType({}), 'reparatie');
  assert.equal(resolveInviteWorkType({ typeParam: '   ', contactTypeField: '' }), 'reparatie');
});

test('resolveInviteWorkType: normaliseert vrije tekst (form en GHL identiek behandeld)', () => {
  assert.equal(resolveInviteWorkType({ typeParam: 'Installatie nieuw' }), 'installatie');
  assert.equal(resolveInviteWorkType({ contactTypeField: 'Reparatie' }), 'reparatie');
});

// ── adres ────────────────────────────────────────────────────────────────────

test('resolveInviteAddress: formulier wint van GHL-contact', () => {
  const contact = { address1: 'GHL straat 1, Amsterdam' };
  assert.equal(
    resolveInviteAddress({ addressParam: 'Formulier 12, Haarlem', contact }),
    'Formulier 12, Haarlem'
  );
});

test('resolveInviteAddress: valt terug op canonieke GHL-adresregel', () => {
  const contact = { address1: 'Oud adres 9' };
  assert.equal(resolveInviteAddress({ addressParam: '', contact }), 'Oud adres 9');
});

test('resolveInviteAddress: leeg formulier + leeg contact → lege string', () => {
  assert.equal(resolveInviteAddress({}), '');
  assert.equal(resolveInviteAddress({ addressParam: '   ', contact: null }), '');
});
