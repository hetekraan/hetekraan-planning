import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkType,
  plannedMinutesForType,
  ghlDurationMinutesForType,
} from '../lib/booking-blocks.js';

test('normalizeWorkType maps Herafspraak to herafspraak', () => {
  assert.equal(normalizeWorkType('Herafspraak'), 'herafspraak');
  assert.equal(normalizeWorkType('herafspraak'), 'herafspraak');
});

test('normalizeWorkType maps herafspraak before reparatie fallback', () => {
  assert.equal(normalizeWorkType('heraf'), 'herafspraak');
  assert.notEqual(normalizeWorkType('Herafspraak'), 'reparatie');
});

test('plannedMinutesForType returns 30 for herafspraak', () => {
  assert.equal(plannedMinutesForType('herafspraak'), 30);
  assert.equal(plannedMinutesForType('Herafspraak'), 30);
});

test('ghlDurationMinutesForType returns 30 for herafspraak', () => {
  assert.equal(ghlDurationMinutesForType('herafspraak'), 30);
  assert.equal(ghlDurationMinutesForType('Herafspraak'), 30);
});
