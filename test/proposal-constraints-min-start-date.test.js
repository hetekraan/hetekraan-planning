import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProposalScanSchedule,
  proposalConstraintsPassCandidate,
} from '../lib/proposal-constraints.js';

test('automatic mode + minStartDate uses scanStartDate as rolling start', () => {
  const schedule = buildProposalScanSchedule({
    startDate: '2026-05-01',
    defaultHorizonDays: 21,
    proposalConstraints: { scanStartDate: '2026-05-11' },
  });
  assert.equal(schedule.kind, 'rolling');
  assert.equal(schedule.start, '2026-05-11');
});

test('weekdays + minStartDate enforces both date floor and weekday filter', () => {
  const constraints = { scanStartDate: '2026-05-11', allowedWeekdays: [1, 2, 3, 4, 5] };
  assert.equal(proposalConstraintsPassCandidate('2026-05-10', 'morning', constraints), false);
  assert.equal(proposalConstraintsPassCandidate('2026-05-11', 'morning', constraints), true);
});

test('specificDates + minStartDate keeps only dates on or after minStartDate', () => {
  const schedule = buildProposalScanSchedule({
    startDate: '2026-05-01',
    defaultHorizonDays: 21,
    proposalConstraints: {
      datesOnly: true,
      allowedDates: ['2026-05-09', '2026-05-11', '2026-05-15'],
      scanStartDate: '2026-05-11',
    },
  });
  assert.equal(schedule.kind, 'list');
  assert.deepEqual(schedule.dates, ['2026-05-11', '2026-05-15']);
});

test('specificDates fully before minStartDate results in empty list', () => {
  const schedule = buildProposalScanSchedule({
    startDate: '2026-05-01',
    defaultHorizonDays: 21,
    proposalConstraints: {
      datesOnly: true,
      allowedDates: ['2026-05-03', '2026-05-05'],
      scanStartDate: '2026-05-11',
    },
  });
  assert.equal(schedule.kind, 'list');
  assert.deepEqual(schedule.dates, []);
});

test('minStartDate in the past never moves schedule before default startDate', () => {
  const schedule = buildProposalScanSchedule({
    startDate: '2026-05-01',
    defaultHorizonDays: 21,
    proposalConstraints: { scanStartDate: '2026-04-01' },
  });
  assert.equal(schedule.kind, 'rolling');
  assert.equal(schedule.start, '2026-05-01');
});

test('minStartDate equal to specific date keeps that date valid', () => {
  const schedule = buildProposalScanSchedule({
    startDate: '2026-05-01',
    defaultHorizonDays: 21,
    proposalConstraints: {
      datesOnly: true,
      allowedDates: ['2026-05-11'],
      scanStartDate: '2026-05-11',
    },
  });
  assert.equal(schedule.kind, 'list');
  assert.deepEqual(schedule.dates, ['2026-05-11']);
});
