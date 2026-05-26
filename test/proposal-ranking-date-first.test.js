import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProposalScanSchedule } from '../lib/proposal-constraints.js';
import { rankProposalCandidates } from '../lib/proposal-ranking.js';

const NOW = '2026-05-22';

test('date-first: lege dag 27 mei wint van geclusterde 2 juni', () => {
  const { ranked } = rankProposalCandidates({
    candidates: [
      {
        dateStr: '2026-05-27',
        block: 'morning',
        evalScore: 500,
        legacyScore: 500,
        nearestDistanceKm: null,
      },
      {
        dateStr: '2026-06-02',
        block: 'morning',
        evalScore: 224,
        legacyScore: 224,
        nearestDistanceKm: 5,
      },
    ],
    nowDateStr: NOW,
  });
  assert.equal(ranked[0].dateStr, '2026-05-27');
  assert.equal(ranked[1].dateStr, '2026-06-02');
});

test('date-first: binnen zelfde dag wint dichtstbijzijnde klant', () => {
  const { ranked } = rankProposalCandidates({
    candidates: [
      {
        dateStr: '2026-05-27',
        block: 'morning',
        evalScore: 300,
        nearestDistanceKm: 20,
      },
      {
        dateStr: '2026-05-27',
        block: 'afternoon',
        evalScore: 300,
        nearestDistanceKm: 3,
      },
      {
        dateStr: '2026-05-27',
        block: 'afternoon',
        evalScore: 250,
        nearestDistanceKm: 8,
      },
    ],
    nowDateStr: NOW,
    kmPerMinute: 0.9,
  });
  assert.equal(ranked[0].block, 'afternoon');
  assert.equal(ranked[0].nearestDistanceKm, 3);
  assert.equal(ranked[1].nearestDistanceKm, 8);
  assert.equal(ranked[2].nearestDistanceKm, 20);
});

test('spoed: dag 1 leeg wint van dag 4 geclusterd', () => {
  const { ranked, mode } = rankProposalCandidates({
    candidates: [
      {
        dateStr: '2026-05-23',
        block: 'morning',
        evalScore: 500,
        nearestDistanceKm: null,
      },
      {
        dateStr: '2026-05-26',
        block: 'morning',
        evalScore: 200,
        nearestDistanceKm: 2,
      },
    ],
    nowDateStr: NOW,
    spoedMode: true,
  });
  assert.equal(mode, 'spoed_date_first');
  assert.equal(ranked[0].dateStr, '2026-05-23');
  assert.equal(ranked[1].dateStr, '2026-05-26');
});

test('horizon 14: dag offset 16 is tier C en verliest van eerdere dag', () => {
  const schedule = buildProposalScanSchedule({
    startDate: '2026-05-23',
    defaultHorizonDays: 14,
    proposalConstraints: null,
  });
  assert.equal(schedule.kind, 'rolling');
  assert.equal(schedule.horizon, 14);
  const withinHorizon = '2026-06-05';
  const day16 = '2026-06-08';
  const { ranked } = rankProposalCandidates({
    candidates: [
      { dateStr: withinHorizon, block: 'morning', evalScore: 100, nearestDistanceKm: 5 },
      { dateStr: day16, block: 'morning', evalScore: 50, nearestDistanceKm: 1 },
    ],
    nowDateStr: '2026-05-23',
    horizonDays: 14,
  });
  assert.equal(ranked[0].dateStr, withinHorizon);
  assert.equal(ranked[0].tier, 'A');
  assert.equal(ranked[1].dateStr, day16);
  assert.equal(ranked[1].tier, 'C');
  assert.equal(ranked[1].dateOffsetDays, 16);
  assert.ok(ranked[0].dateOffsetDays <= 14);
});

test('legacy ranking: clustering kan nog vroegere datum overschrijven via legacyScore', () => {
  const { ranked, mode } = rankProposalCandidates({
    candidates: [
      {
        dateStr: '2026-05-27',
        block: 'morning',
        evalScore: 500,
        legacyScore: 900,
      },
      {
        dateStr: '2026-06-02',
        block: 'morning',
        evalScore: 224,
        legacyScore: 200,
      },
    ],
    nowDateStr: NOW,
    enableLegacyRanking: true,
  });
  assert.equal(mode, 'legacy');
  assert.equal(ranked[0].dateStr, '2026-06-02');
});

test('Daan scenario top-2: 27 en 28/29 mei vóór 2 juni', () => {
  const { ranked } = rankProposalCandidates({
    candidates: [
      { dateStr: '2026-05-27', block: 'morning', evalScore: 500, legacyScore: 500 },
      { dateStr: '2026-05-28', block: 'morning', evalScore: 480, legacyScore: 480 },
      { dateStr: '2026-05-29', block: 'afternoon', evalScore: 470, legacyScore: 470 },
      {
        dateStr: '2026-06-02',
        block: 'morning',
        evalScore: 224,
        legacyScore: 224,
        nearestDistanceKm: 4,
      },
    ],
    nowDateStr: NOW,
  });
  const top2 = ranked.slice(0, 2).map((c) => c.dateStr);
  assert.deepEqual(top2, ['2026-05-27', '2026-05-28']);
});
