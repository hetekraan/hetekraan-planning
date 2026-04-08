(function () {
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

  window.HKPlannerUtils = {
    formatDate,
    fmtEuro,
    escapePriceAttr,
    euroDisplay,
  };
})();
