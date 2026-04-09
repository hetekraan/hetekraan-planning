(function () {
  const SLOT_CONFIG = {
    morning: { key: 'morning', label: '09:00–13:00', startTime: '09:00', dayPart: 0 },
    afternoon: { key: 'afternoon', label: '13:00–17:00', startTime: '13:00', dayPart: 1 },
  };

  function formatDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('nl-NL', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Amsterdam',
    });
  }

  function fmtEuro(amount) {
    return '€\u202F' + Number(amount).toLocaleString('nl-NL', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function escapePriceAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function euroDisplay(value) {
    const x = Number(value);
    if (!Number.isFinite(x)) return '0';
    const rounded = Math.round(x * 100) / 100;
    return rounded.toLocaleString('nl-NL', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  function getPlannerSlotConfig(slotKey) {
    return SLOT_CONFIG[String(slotKey || '').trim()] || SLOT_CONFIG.morning;
  }

  function inferPlannerSlotKey(input) {
    const dayPart = Number(input?.dayPart);
    if (dayPart === 0) return 'morning';
    if (dayPart === 1) return 'afternoon';
    const timeWindow = String(input?.timeWindow || '').toLowerCase();
    if (timeWindow.includes('13:00–17:00') || timeWindow.includes('13:00-17:00') || timeWindow.includes('middag')) {
      return 'afternoon';
    }
    if (timeWindow.includes('09:00–13:00') || timeWindow.includes('09:00-13:00') || timeWindow.includes('ochtend')) {
      return 'morning';
    }
    const t = String(input?.timeSlot || '').trim();
    if (/^\d{2}:\d{2}$/.test(t) && Number(t.slice(0, 2)) >= 13) return 'afternoon';
    return 'morning';
  }

  function plannerDateFromYmd(ymd) {
    const m = String(ymd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  }

  window.HKPlannerUtils = {
    formatDate,
    fmtEuro,
    escapePriceAttr,
    euroDisplay,
    getPlannerSlotConfig,
    inferPlannerSlotKey,
    plannerDateFromYmd,
  };
})();
