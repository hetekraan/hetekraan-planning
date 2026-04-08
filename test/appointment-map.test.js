import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapEnrichedGhlEventToAppointment,
  plannerServiceMarkedCompleteOnRouteDay,
} from '../lib/planning/appointment.js';

test('plannerServiceMarkedCompleteOnRouteDay matches same route date', () => {
  assert.equal(plannerServiceMarkedCompleteOnRouteDay('2026-04-08', '2026-04-08'), true);
  assert.equal(plannerServiceMarkedCompleteOnRouteDay('2026-04-07', '2026-04-08'), false);
});

test('mapEnrichedGhlEventToAppointment computes base from canonical total minus extras', () => {
  const ev = {
    id: 'evt-1',
    startTime: new Date('2026-04-08T09:00:00+02:00').toISOString(),
    contactId: 'c1',
    parsedPrice: '440',
    parsedExtras: [{ desc: 'mengventiel', price: 40 }],
    parsedWork: 'Werk',
    parsedJobType: 'onderhoud',
    contact: {
      firstName: 'Jan',
      lastName: 'Test',
      customFields: [{ id: 'hiTe3Yi5TlxheJq4bLzy', value: '2026-04-08' }],
    },
  };
  const a = mapEnrichedGhlEventToAppointment(ev, 0, '2026-04-08');
  assert.equal(a.price, 400);
  assert.equal(a.extras.length, 1);
  assert.equal(a.status, 'klaar');
});
