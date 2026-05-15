import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEtaFromTravelMinutes,
  etaDiffMinutes,
  minutesToTimeStr,
  parseTimeToMinutes,
} from '../lib/route-eta-time.js';

test('minutesToTimeStr formats HH:MM', () => {
  assert.equal(minutesToTimeStr(9 * 60 + 5), '09:05');
  assert.equal(minutesToTimeStr(14 * 60 + 45), '14:45');
});

test('computeEtaFromTravelMinutes adds travel to now', () => {
  assert.equal(computeEtaFromTravelMinutes(30, 10 * 60), '10:30');
  assert.equal(computeEtaFromTravelMinutes(7.2, 10 * 60), '10:08');
});

test('etaDiffMinutes within same day', () => {
  assert.equal(etaDiffMinutes('10:00', '10:04'), 4);
  assert.equal(etaDiffMinutes('10:00', '10:06'), 6);
});

test('parseTimeToMinutes rejects invalid', () => {
  assert.equal(parseTimeToMinutes('25:00'), null);
  assert.equal(parseTimeToMinutes(''), null);
});
