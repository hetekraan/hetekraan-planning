(function initPlannerStorage(global) {
  const HK_KLAAR_KEY = 'hk_klaar_ids';

  function klaarStorageKeyContactDate(contactId, routeYmd) {
    const c = String(contactId || '').trim();
    const d = String(routeYmd || '').trim();
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    return `cid:${c}:${d}`;
  }

  function saveKlaarStatus(ghlId, contactId, routeYmd) {
    try {
      const map = JSON.parse(localStorage.getItem(HK_KLAAR_KEY) || '{}');
      if (ghlId) map[String(ghlId)] = Date.now();
      const cd = klaarStorageKeyContactDate(contactId, routeYmd);
      if (cd) map[cd] = Date.now();
      const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
      for (const [k, v] of Object.entries(map)) {
        if (v < cutoff) delete map[k];
      }
      localStorage.setItem(HK_KLAAR_KEY, JSON.stringify(map));
    } catch {}
  }

  function isKlaarLocally(ghlId) {
    if (!ghlId) return false;
    try {
      const map = JSON.parse(localStorage.getItem(HK_KLAAR_KEY) || '{}');
      return !!map[ghlId];
    } catch {
      return false;
    }
  }

  function isKlaarLocallyContactDate(contactId, routeYmd) {
    const cd = klaarStorageKeyContactDate(contactId, routeYmd);
    if (!cd) return false;
    try {
      const map = JSON.parse(localStorage.getItem(HK_KLAAR_KEY) || '{}');
      return !!map[cd];
    } catch {
      return false;
    }
  }

  global.HKPlannerStorage = {
    saveKlaarStatus,
    isKlaarLocally,
    isKlaarLocallyContactDate,
    klaarStorageKeyContactDate,
  };
})(window);
