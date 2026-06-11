/**
 * Cache-warming beslissing voor ochtendmelding-instellingen bij een planner-load.
 * Puur en getest; gebruikt door index.html (warmMorningMessageCache) en de tests.
 */

/**
 * @param {{ cacheDateStr?: string, dateStr?: string }} input
 * @returns {boolean} true als de morning-settings cache (her)laden moet worden
 */
export function shouldWarmMorningCache({ cacheDateStr, dateStr } = {}) {
  const ds = String(dateStr || '').trim();
  if (!ds) return false;
  const cached = String(cacheDateStr || '').trim();
  return cached !== ds;
}
