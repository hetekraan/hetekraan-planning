(function initPlannerRouteMode(global) {
  function resolveRouteStateMode(input = {}) {
    if (input.routeRefactorEnabled === false) return 'disabled';
    if (input.routeLockStoreConfigured !== true) return 'disabled';
    if (input.routeLock && input.routeLock.locked === true) return 'serverConfirmed';
    return 'localDraft';
  }

  function routeRevision(routeLock) {
    const n = Number(routeLock?.revision);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function routeUpdatedBy(routeLock) {
    const raw = String(routeLock?.updatedBy || '').trim();
    return raw || '';
  }

  function serverUpdateToastText(routeLock) {
    const name = routeUpdatedBy(routeLock);
    if (name) return `De route is bijgewerkt door ${name}. Jouw onbevestigde wijzigingen zijn vervallen.`;
    return 'De route is centraal bijgewerkt. Jouw onbevestigde wijzigingen zijn vervallen.';
  }

  function detectRouteModeSwitch({
    previousMode,
    nextMode,
    routeLock,
    routeRefactorEnabled = true,
    previousRevision = 0,
    nextRevision,
  } = {}) {
    if (routeRefactorEnabled === false) {
      return {
        modeChanged: false,
        discardLocalDraft: false,
        serverLockReleased: false,
        toastMessage: '',
        shouldScheduleRevisionFollowup: false,
      };
    }

    const nextRev = Number.isFinite(Number(nextRevision)) ? Math.floor(Number(nextRevision)) : routeRevision(routeLock);
    const prevRev = Number.isFinite(Number(previousRevision)) ? Math.floor(Number(previousRevision)) : 0;
    const locked = !!(routeLock && routeLock.locked === true);
    const modeChanged = !!previousMode && previousMode !== nextMode;
    const discardLocalDraft = modeChanged && previousMode === 'localDraft' && nextMode === 'serverConfirmed';
    const serverLockReleased = modeChanged && previousMode === 'serverConfirmed' && nextMode === 'localDraft';

    return {
      modeChanged,
      discardLocalDraft,
      serverLockReleased,
      toastMessage: discardLocalDraft ? serverUpdateToastText(routeLock) : '',
      shouldScheduleRevisionFollowup: locked && nextRev > prevRev,
      previousRevision: prevRev,
      nextRevision: nextRev,
    };
  }

  global.HKPlannerRouteMode = {
    resolveRouteStateMode,
    routeRevision,
    routeUpdatedBy,
    serverUpdateToastText,
    detectRouteModeSwitch,
  };
})(typeof window !== 'undefined' ? window : globalThis);
