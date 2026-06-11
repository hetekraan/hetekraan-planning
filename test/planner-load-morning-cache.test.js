import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldWarmMorningCache } from '../public/app/planner-load-morning-cache-core.mjs';

test('warms when cache is empty (boot)', () => {
  assert.equal(shouldWarmMorningCache({ cacheDateStr: '', dateStr: '2026-06-11' }), true);
});

test('warms when cache is for a different date', () => {
  assert.equal(shouldWarmMorningCache({ cacheDateStr: '2026-06-10', dateStr: '2026-06-11' }), true);
});

test('does not warm when cache already covers this date', () => {
  assert.equal(shouldWarmMorningCache({ cacheDateStr: '2026-06-11', dateStr: '2026-06-11' }), false);
});

test('does not warm without a target date', () => {
  assert.equal(shouldWarmMorningCache({ cacheDateStr: '2026-06-11', dateStr: '' }), false);
  assert.equal(shouldWarmMorningCache({}), false);
});

test('simulated load flow only refetches on cold/stale cache', async () => {
  let fetches = 0;
  let cacheDateStr = '';
  const refresh = async (dateStr) => {
    if (shouldWarmMorningCache({ cacheDateStr, dateStr })) {
      fetches += 1;
      cacheDateStr = dateStr;
    }
  };
  await refresh('2026-06-11'); // boot: cold → fetch
  await refresh('2026-06-11'); // same date: warm → skip
  await refresh('2026-06-12'); // date switch: stale → fetch
  assert.equal(fetches, 2);
  assert.equal(cacheDateStr, '2026-06-12');
});
