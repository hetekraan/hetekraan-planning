(function () {
  const HK_DASH_BLOCKED_DATES_KEY = 'hk_dash_blocked_dates';

  function readDashBlockedDates() {
    try {
      const raw = localStorage.getItem(HK_DASH_BLOCKED_DATES_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return typeof data === 'object' && data && !Array.isArray(data) ? data : {};
    } catch (_) {
      return {};
    }
  }

  function writeDashBlockedDates(data) {
    try {
      localStorage.setItem(HK_DASH_BLOCKED_DATES_KEY, JSON.stringify(data || {}));
    } catch (_) {}
  }

  function markDashBlockedDate(dateStr) {
    if (!dateStr) return;
    const data = readDashBlockedDates();
    data[String(dateStr)] = Date.now();
    writeDashBlockedDates(data);
  }

  function clearDashBlockedDate(dateStr) {
    if (!dateStr) return;
    const data = readDashBlockedDates();
    if (data[dateStr] == null) return;
    delete data[dateStr];
    writeDashBlockedDates(data);
  }

  function isDashBlockedPending(dateStr) {
    if (!dateStr) return false;
    return readDashBlockedDates()[dateStr] != null;
  }

  window.HKPlannerBlockState = {
    readDashBlockedDates,
    writeDashBlockedDates,
    markDashBlockedDate,
    clearDashBlockedDate,
    isDashBlockedPending,
  };
})();
