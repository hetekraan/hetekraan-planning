import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlannerAutoRefreshController,
  PLANNER_AUTO_REFRESH_MS,
  PLANNER_FOCUS_REFRESH_MIN_MS,
} from '../public/app/planner-auto-refresh-core.mjs';

test('interval tick calls quiet load when visible', async () => {
  let now = 1000;
  let loadCalls = 0;
  const intervals = [];
  const ctl = createPlannerAutoRefreshController({
    intervalMs: PLANNER_AUTO_REFRESH_MS,
    focusMinMs: PLANNER_FOCUS_REFRESH_MIN_MS,
    loadQuiet: async () => {
      loadCalls += 1;
    },
    isDocumentVisible: () => true,
    setIntervalFn: (fn, ms) => {
      assert.equal(ms, PLANNER_AUTO_REFRESH_MS);
      intervals.push(fn);
      return 42;
    },
    clearIntervalFn: () => {},
    nowFn: () => now,
  });
  ctl.start();
  assert.equal(intervals.length, 1);
  await intervals[0]();
  assert.equal(loadCalls, 1);
  ctl.stop();
});

test('skips refresh when document hidden', async () => {
  let loadCalls = 0;
  const ctl = createPlannerAutoRefreshController({
    loadQuiet: async () => {
      loadCalls += 1;
    },
    isDocumentVisible: () => false,
  });
  await ctl.tryBackgroundRefresh('interval');
  assert.equal(loadCalls, 0);
});

test('focus refresh is throttled within focusMinMs', async () => {
  let now = 5000;
  let loadCalls = 0;
  const ctl = createPlannerAutoRefreshController({
    focusMinMs: 10000,
    loadQuiet: async () => {
      loadCalls += 1;
    },
    isDocumentVisible: () => true,
    nowFn: () => now,
  });
  await ctl.tryBackgroundRefresh('focus');
  assert.equal(loadCalls, 1);
  now += 3000;
  await ctl.tryBackgroundRefresh('focus');
  assert.equal(loadCalls, 1);
  now += 8000;
  await ctl.tryBackgroundRefresh('focus');
  assert.equal(loadCalls, 2);
});

test('skips when load is inflight', async () => {
  let loadCalls = 0;
  const ctl = createPlannerAutoRefreshController({
    getInflight: () => 1,
    loadQuiet: async () => {
      loadCalls += 1;
    },
    isDocumentVisible: () => true,
  });
  await ctl.tryBackgroundRefresh('interval');
  assert.equal(loadCalls, 0);
});

test('stop clears interval', () => {
  let cleared = null;
  const ctl = createPlannerAutoRefreshController({
    loadQuiet: async () => {},
    setIntervalFn: () => 99,
    clearIntervalFn: (id) => {
      cleared = id;
    },
  });
  ctl.start();
  ctl.stop();
  assert.equal(cleared, 99);
});
