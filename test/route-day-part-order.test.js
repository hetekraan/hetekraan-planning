import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceMorningBeforeAfternoonOrder,
  resolveAppointmentDayPart,
} from '../lib/route-day-part-order.js';
import { optimizeForRouteState } from '../lib/route-live-optimizer.js';

test('resolveAppointmentDayPart uses dayPart and timeWindow', () => {
  assert.equal(resolveAppointmentDayPart({ dayPart: 0 }), 0);
  assert.equal(resolveAppointmentDayPart({ dayPart: 1 }), 1);
  assert.equal(resolveAppointmentDayPart({ timeWindow: '09:00–13:00' }), 0);
  assert.equal(resolveAppointmentDayPart({ timeWindow: '13:00-17:00' }), 1);
});

test('enforceMorningBeforeAfternoonOrder keeps morning before afternoon', () => {
  const appointments = [
    { contactId: 'maartje', dayPart: 1, timeWindow: '13:00–17:00' },
    { contactId: 'kees', dayPart: 0, timeWindow: '09:00–13:00' },
    { contactId: 'fred', dayPart: 0, timeWindow: '09:00–13:00' },
    { contactId: 'ramon', dayPart: 0 },
    { contactId: 'kolk', dayPart: 0 },
    { contactId: 'maaike', dayPart: 1 },
    { contactId: 'other', dayPart: 1 },
  ];
  const mixed = ['maartje', 'kees', 'maaike', 'fred', 'kolk', 'ramon', 'other'];
  const ordered = enforceMorningBeforeAfternoonOrder(mixed, appointments);
  const morning = ['kees', 'fred', 'kolk', 'ramon'];
  const afternoon = ['maartje', 'maaike', 'other'];
  assert.deepEqual(ordered.slice(0, 4), morning);
  assert.deepEqual(ordered.slice(4), afternoon);
});

test('optimizeForRouteState enforces morning before afternoon after geo optimize', async () => {
  const active = [
    { contactId: 'kees', dayPart: 0, status: 'ingepland' },
    { contactId: 'ramon', dayPart: 0, status: 'ingepland' },
    { contactId: 'kolk', dayPart: 0, status: 'ingepland' },
    { contactId: 'fred', dayPart: 0, status: 'ingepland' },
    { contactId: 'maartje', dayPart: 1, status: 'ingepland' },
    { contactId: 'maaike', dayPart: 1, status: 'ingepland' },
    { contactId: 'other', dayPart: 1, status: 'ingepland' },
  ];
  const plan = await optimizeForRouteState({
    activeAppointments: active,
    routeState: { orderContactIds: [] },
    optimizeRoute: async ({ appointments }) => ({
      orderContactIds: appointments.map((a) => a.contactId).reverse(),
      etasByContactId: {},
    }),
  });
  const morning = plan.orderContactIds.slice(0, 4);
  const afternoon = plan.orderContactIds.slice(4);
  assert.equal(morning.length, 4);
  assert.equal(afternoon.length, 3);
  assert.deepEqual([...morning].sort(), ['fred', 'kees', 'kolk', 'ramon'].sort());
  assert.deepEqual([...afternoon].sort(), ['maaike', 'maartje', 'other'].sort());
  assert.ok(morning.includes('fred'));
  assert.ok(afternoon.includes('maartje'));
});
