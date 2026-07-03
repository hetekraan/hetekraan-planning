import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_APPOINTMENT_MINUTES,
  normalizeWorkType,
  plannedMinutesForType,
  ghlDurationMinutesForType,
  plannedMinutesForExistingEvent,
} from '../lib/booking-blocks.js';

test('normalizeWorkType maps Herafspraak to herafspraak', () => {
  assert.equal(normalizeWorkType('Herafspraak'), 'herafspraak');
  assert.equal(normalizeWorkType('herafspraak'), 'herafspraak');
});

test('normalizeWorkType maps herafspraak before reparatie fallback', () => {
  assert.equal(normalizeWorkType('heraf'), 'herafspraak');
  assert.notEqual(normalizeWorkType('Herafspraak'), 'reparatie');
});

test('plannedMinutesForType returns 50 for all types', () => {
  assert.equal(DEFAULT_APPOINTMENT_MINUTES, 50);
  assert.equal(plannedMinutesForType('herafspraak'), 50);
  assert.equal(plannedMinutesForType('Herafspraak'), 50);
  assert.equal(plannedMinutesForType('installatie'), 50);
  assert.equal(plannedMinutesForType('reparatie'), 50);
});

test('ghlDurationMinutesForType returns 50 for all types', () => {
  assert.equal(ghlDurationMinutesForType('herafspraak'), 50);
  assert.equal(ghlDurationMinutesForType('Herafspraak'), 50);
  assert.equal(ghlDurationMinutesForType('installatie'), 50);
});

test('plannedMinutesForExistingEvent uses end-start when available', () => {
  const start = Date.parse('2026-07-03T09:00:00+02:00');
  const end = Date.parse('2026-07-03T10:30:00+02:00');
  assert.equal(
    plannedMinutesForExistingEvent({ startTime: start, endTime: end }),
    90
  );
});

test('plannedMinutesForExistingEvent falls back to default without times', () => {
  assert.equal(plannedMinutesForExistingEvent({ title: 'Installatie Jan' }), 50);
  assert.equal(plannedMinutesForExistingEvent({}), 50);
});
