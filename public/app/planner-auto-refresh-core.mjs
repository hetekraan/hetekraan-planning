/** @typedef {'interval' | 'focus' | 'visibility'} PlannerAutoRefreshReason */

export const PLANNER_AUTO_REFRESH_MS = 30000;
export const PLANNER_FOCUS_REFRESH_MIN_MS = 10000;

/**
 * @param {{
 *   intervalMs?: number;
 *   focusMinMs?: number;
 *   loadQuiet: () => Promise<unknown>;
 *   getInflight?: () => number;
 *   isDocumentVisible?: () => boolean;
 *   modalBlocks?: () => boolean;
 *   routeDragBlocks?: () => boolean;
 *   routeSaveBlocks?: () => boolean;
 *   priceDebounceBlocks?: () => boolean;
 *   debug?: (tag: string, payload?: Record<string, unknown>) => void;
 *   setIntervalFn?: typeof setInterval;
 *   clearIntervalFn?: typeof clearInterval;
 *   nowFn?: () => number;
 * }} deps
 */
export function createPlannerAutoRefreshController(deps) {
  const intervalMs = deps.intervalMs ?? PLANNER_AUTO_REFRESH_MS;
  const focusMinMs = deps.focusMinMs ?? PLANNER_FOCUS_REFRESH_MIN_MS;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const nowFn = deps.nowFn ?? Date.now;
  const debug = deps.debug ?? (() => {});

  let timerId = null;
  let lastRefreshAt = 0;

  async function tryBackgroundRefresh(reason) {
    const inflight = typeof deps.getInflight === 'function' ? deps.getInflight() : 0;
    if (inflight > 0) {
      debug('PLANNER_AUTO_REFRESH_SKIP', { reason, why: 'loadAppointments_inflight' });
      return;
    }
    const isVisible = typeof deps.isDocumentVisible === 'function' ? deps.isDocumentVisible() : true;
    if (!isVisible) {
      debug('PLANNER_AUTO_REFRESH_SKIP', { reason, why: 'document_hidden' });
      return;
    }
    if (deps.modalBlocks?.()) {
      debug('PLANNER_AUTO_REFRESH_SKIP', { reason, why: 'modal_or_touch_price_open' });
      return;
    }
    if (deps.routeDragBlocks?.()) {
      debug('PLANNER_AUTO_REFRESH_SKIP', { reason, why: 'route_drag_active' });
      return;
    }
    if (deps.routeSaveBlocks?.()) {
      debug('PLANNER_AUTO_REFRESH_SKIP', { reason, why: 'route_write_inflight' });
      return;
    }
    if (deps.priceDebounceBlocks?.()) {
      debug('PLANNER_AUTO_REFRESH_SKIP', { reason, why: 'price_lines_debounce_pending' });
      return;
    }
    const now = nowFn();
    if (
      (reason === 'focus' || reason === 'visibility') &&
      lastRefreshAt > 0 &&
      now - lastRefreshAt < focusMinMs
    ) {
      debug('PLANNER_AUTO_REFRESH_SKIP', {
        reason,
        why: 'throttle_focus_visibility',
        msSinceLast: now - lastRefreshAt,
      });
      return;
    }
    lastRefreshAt = now;
    debug('PLANNER_AUTO_REFRESH_START', { reason });
    try {
      console.log('[scroll-debug] auto-refresh tryBackgroundRefresh', { reason });
      await deps.loadQuiet(reason);
      debug('PLANNER_AUTO_REFRESH_DONE', { reason });
    } catch (e) {
      debug('PLANNER_AUTO_REFRESH_DONE', { reason, error: String(e?.message || e) });
    }
  }

  function start() {
    stop();
    timerId = setIntervalFn(() => {
      void tryBackgroundRefresh('interval');
    }, intervalMs);
  }

  function stop() {
    if (timerId != null) {
      clearIntervalFn(timerId);
      timerId = null;
    }
  }

  return { start, stop, tryBackgroundRefresh };
}
