import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOptimizedOrderToRoute,
  enforceMorningBeforeAfternoonOrder,
  resolveAppointmentDayPart,
  routeOrderViolatesMorningBeforeAfternoon,
} from '../lib/route-day-part-order.js';
import { optimizeForRouteState, triggerLiveRouteRecalculation } from '../lib/route-live-optimizer.js';

test('resolveAppointmentDayPart uses dayPart and timeWindow', () => {
  assert.equal(resolveAppointmentDayPart({ dayPart: 0 }), 0);
  assert.equal(resolveAppointmentDayPart({ dayPart: 1 }), 1);
  assert.equal(resolveAppointmentDayPart({ timeWindow: '09:00–13:00' }), 0);
  assert.equal(resolveAppointmentDayPart({ timeWindow: '13:00-17:00' }), 1);
});

test('resolveAppointmentDayPart infers morning from startMs before 13:00 Amsterdam', () => {
  const morningMs = Date.parse('2026-05-19T08:30:00+02:00');
  const afternoonMs = Date.parse('2026-05-19T14:00:00+02:00');
  assert.equal(resolveAppointmentDayPart({ startMs: morningMs }), 0);
  assert.equal(resolveAppointmentDayPart({ startMs: afternoonMs }), 1);
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

test('routeOrderViolatesMorningBeforeAfternoon detects fred-last legacy order', () => {
  const appointments = [
    { contactId: 'kees', dayPart: 0, status: 'ingepland' },
    { contactId: 'ramon', dayPart: 0, status: 'ingepland' },
    { contactId: 'kolk', dayPart: 0, status: 'ingepland' },
    { contactId: 'maartje', dayPart: 1, status: 'ingepland' },
    { contactId: 'maaike', dayPart: 1, status: 'ingepland' },
    { contactId: 'other', dayPart: 1, status: 'ingepland' },
    { contactId: 'fred', dayPart: 0, status: 'ingepland' },
  ];
  const legacy = ['kees', 'ramon', 'kolk', 'maartje', 'maaike', 'other', 'fred'];
  assert.equal(routeOrderViolatesMorningBeforeAfternoon(legacy, appointments), true);
  const fixed = enforceMorningBeforeAfternoonOrder(legacy, appointments);
  assert.equal(routeOrderViolatesMorningBeforeAfternoon(fixed, appointments), false);
});

test('applyOptimizedOrderToRoute maps fred to stop 4 in legacy layout', () => {
  const appointments = [
    { contactId: 'kees', dayPart: 0, status: 'ingepland' },
    { contactId: 'ramon', dayPart: 0, status: 'ingepland' },
    { contactId: 'kolk', dayPart: 0, status: 'ingepland' },
    { contactId: 'maartje', dayPart: 1, status: 'ingepland' },
    { contactId: 'maaike', dayPart: 1, status: 'ingepland' },
    { contactId: 'other', dayPart: 1, status: 'ingepland' },
    { contactId: 'fred', dayPart: 0, status: 'ingepland' },
  ];
  const legacy = ['kees', 'ramon', 'kolk', 'maartje', 'maaike', 'other', 'fred'];
  const optimized = enforceMorningBeforeAfternoonOrder(legacy, appointments);
  const merged = applyOptimizedOrderToRoute(legacy, appointments, optimized);
  assert.equal(merged.indexOf('fred') + 1, 4);
  assert.equal(merged.indexOf('maartje') + 1, 5);
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

test('triggerLiveRouteRecalculation repairs day-part violation without preserveOrder', async () => {
  const appointments = [
    { contactId: 'kees', dayPart: 0, status: 'ingepland', fullAddressLine: 'A' },
    { contactId: 'ramon', dayPart: 0, status: 'ingepland', fullAddressLine: 'B' },
    { contactId: 'kolk', dayPart: 0, status: 'ingepland', fullAddressLine: 'C' },
    { contactId: 'maartje', dayPart: 1, status: 'ingepland', fullAddressLine: 'D' },
    { contactId: 'maaike', dayPart: 1, status: 'ingepland', fullAddressLine: 'E' },
    { contactId: 'other', dayPart: 1, status: 'ingepland', fullAddressLine: 'F' },
    { contactId: 'fred', dayPart: 0, status: 'ingepland', fullAddressLine: 'Heiloo' },
  ];
  const initial = {
    schemaVersion: 1,
    revision: 2,
    orderContactIds: ['kees', 'ramon', 'kolk', 'maartje', 'maaike', 'other', 'fred'],
    etasByContactId: {},
    pinsByContactId: {},
  };
  let firstCallPreserve = null;
  const out = await triggerLiveRouteRecalculation({
    locationId: 'loc-1',
    dateStr: '2026-05-19',
    appointments,
    reason: 'day_part_order_repair',
    deps: {
      ensureRouteLiveState: async () => ({ ok: true, routeState: initial }),
      optimizeRoute: async ({ appointments: rows, preserveOrder }) => {
        if (firstCallPreserve === null) firstCallPreserve = preserveOrder === true;
        return {
          orderContactIds: rows.map((a) => a.contactId),
          etasByContactId: {},
        };
      },
      setRouteLiveState: async (_loc, _date, payload) => ({
        ok: true,
        routeState: { ...payload, revision: 3 },
      }),
    },
  });
  assert.equal(out.ok, true);
  assert.equal(firstCallPreserve, false);
  assert.equal(out.routeState.orderContactIds.indexOf('fred') + 1, 4);
});
