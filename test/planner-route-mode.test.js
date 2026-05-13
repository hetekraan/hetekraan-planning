import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadRouteModeContext() {
  const context = { console };
  context.window = context;
  const source = fs.readFileSync(new URL('../public/app/planner-route-mode.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);
  return context.HKPlannerRouteMode;
}

test('resolveRouteStateMode returns disabled when route refactor is disabled', () => {
  const mode = loadRouteModeContext();
  assert.equal(
    mode.resolveRouteStateMode({
      routeRefactorEnabled: false,
      routeLockStoreConfigured: true,
      routeLock: { locked: true },
    }),
    'disabled'
  );
});

test('resolveRouteStateMode returns disabled when route lock store is unavailable', () => {
  const mode = loadRouteModeContext();
  assert.equal(
    mode.resolveRouteStateMode({
      routeRefactorEnabled: true,
      routeLockStoreConfigured: false,
      routeLock: { locked: true },
    }),
    'disabled'
  );
});

test('resolveRouteStateMode returns serverConfirmed for a locked central route', () => {
  const mode = loadRouteModeContext();
  assert.equal(
    mode.resolveRouteStateMode({
      routeRefactorEnabled: true,
      routeLockStoreConfigured: true,
      routeLock: { locked: true },
    }),
    'serverConfirmed'
  );
});

test('resolveRouteStateMode returns localDraft when central route is missing or unlocked', () => {
  const mode = loadRouteModeContext();
  assert.equal(
    mode.resolveRouteStateMode({
      routeRefactorEnabled: true,
      routeLockStoreConfigured: true,
      routeLock: null,
    }),
    'localDraft'
  );
  assert.equal(
    mode.resolveRouteStateMode({
      routeRefactorEnabled: true,
      routeLockStoreConfigured: true,
      routeLock: { locked: false },
    }),
    'localDraft'
  );
});

test('localDraft to serverConfirmed detects discard and toast text', () => {
  const mode = loadRouteModeContext();
  const out = mode.detectRouteModeSwitch({
    previousMode: 'localDraft',
    nextMode: 'serverConfirmed',
    routeLock: { locked: true, revision: 2, updatedBy: 'Jerry' },
    previousRevision: 1,
    routeRefactorEnabled: true,
  });
  assert.equal(out.discardLocalDraft, true);
  assert.equal(out.toastMessage, 'De route is bijgewerkt door Jerry. Jouw onbevestigde wijzigingen zijn vervallen.');
});

test('serverConfirmed to localDraft detects released lock without toast', () => {
  const mode = loadRouteModeContext();
  const out = mode.detectRouteModeSwitch({
    previousMode: 'serverConfirmed',
    nextMode: 'localDraft',
    routeLock: { locked: false, revision: 3 },
    previousRevision: 2,
    routeRefactorEnabled: true,
  });
  assert.equal(out.serverLockReleased, true);
  assert.equal(out.toastMessage, '');
});

test('higher locked revision schedules one follow-up signal', () => {
  const mode = loadRouteModeContext();
  const out = mode.detectRouteModeSwitch({
    previousMode: 'serverConfirmed',
    nextMode: 'serverConfirmed',
    routeLock: { locked: true, revision: 5 },
    previousRevision: 4,
    routeRefactorEnabled: true,
  });
  assert.equal(out.shouldScheduleRevisionFollowup, true);
});

test('feature flag disabled suppresses switch and follow-up signals', () => {
  const mode = loadRouteModeContext();
  const out = mode.detectRouteModeSwitch({
    previousMode: 'localDraft',
    nextMode: 'serverConfirmed',
    routeLock: { locked: true, revision: 5 },
    previousRevision: 1,
    routeRefactorEnabled: false,
  });
  assert.equal(out.discardLocalDraft, false);
  assert.equal(out.serverLockReleased, false);
  assert.equal(out.shouldScheduleRevisionFollowup, false);
});
