(function initPlannerBuslijst(global) {
  const GROUP_ORDER = ['Kranen', 'Quookers', 'Serviceproducten'];
  let weekStart = '';
  let loadSeq = 0;

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return (
      global.HKPlannerAuthSession?.hkAuthHeader?.({
        localStorageImpl: global.localStorage,
        documentRef: document,
      }) || ''
    );
  }

  function escHtml(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function isValidYmd(ymd) {
    const raw = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
    const [y, m, d] = raw.split('-').map((x) => parseInt(x, 10));
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function ymdFromUtcDate(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseYmd(ymd) {
    const [y, m, d] = String(ymd).split('-').map((x) => parseInt(x, 10));
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }

  function addDaysYmd(ymd, days) {
    const dt = parseYmd(ymd);
    dt.setUTCDate(dt.getUTCDate() + days);
    return ymdFromUtcDate(dt);
  }

  function amsterdamTodayYmd() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** Maandag van de week waarin `ymd` valt (UTC-noon dates, ISO-week). */
  function mondayOfWeekContaining(ymd) {
    const dt = parseYmd(ymd);
    const dow = dt.getUTCDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    dt.setUTCDate(dt.getUTCDate() + diff);
    return ymdFromUtcDate(dt);
  }

  function isoWeekNumberForMonday(mondayYmd) {
    const d = parseYmd(mondayYmd);
    const target = new Date(d);
    target.setUTCDate(target.getUTCDate() + 3);
    const week1 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    return (
      1 +
      Math.round(
        ((target.getTime() - week1.getTime()) / 86400000 -
          3 +
          ((week1.getUTCDay() + 6) % 7)) /
          7
      )
    );
  }

  function formatShortNl(ymd) {
    return parseYmd(ymd).toLocaleDateString('nl-NL', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  function formatWeekNavLabel(mondayYmd) {
    const fridayYmd = addDaysYmd(mondayYmd, 4);
    const weekNo = isoWeekNumberForMonday(mondayYmd);
    return `Week ${weekNo} (${formatShortNl(mondayYmd)} – ${formatShortNl(fridayYmd)})`;
  }

  function readWeekStartFromUrl() {
    try {
      const url = new URL(global.location.href);
      const ws = String(url.searchParams.get('weekStart') || '').trim();
      if (isValidYmd(ws)) return mondayOfWeekContaining(ws);
    } catch (_) {}
    return mondayOfWeekContaining(amsterdamTodayYmd());
  }

  function writeBuslijstUrl(nextWeekStart) {
    try {
      const url = new URL(global.location.href);
      url.searchParams.set('view', 'buslijst');
      url.searchParams.set('weekStart', nextWeekStart);
      global.history.replaceState(
        null,
        '',
        `${url.pathname}?${url.searchParams.toString()}${url.hash || ''}`
      );
    } catch (_) {}
  }

  function setWeekNavLabel() {
    const el = document.getElementById('buslijstWeekLabel');
    if (el) el.textContent = formatWeekNavLabel(weekStart);
  }

  function renderLoading() {
    const el = document.getElementById('buslijstContent');
    if (!el) return;
    el.innerHTML = '<p class="buslijst-status">Buslijst laden…</p>';
  }

  function renderError(message) {
    const el = document.getElementById('buslijstContent');
    if (!el) return;
    el.innerHTML = `<p class="buslijst-status buslijst-status--error">${escHtml(message)}</p>`;
  }

  function renderDay(day) {
    const groups = day?.groups && typeof day.groups === 'object' ? day.groups : {};
    const hasGroups = GROUP_ORDER.some((g) => Array.isArray(groups[g]) && groups[g].length > 0);
    if (!hasGroups) {
      return `<section class="buslijst-day" data-date="${escHtml(day.date)}">
        <h2 class="buslijst-day-title">${escHtml(day.dayLabel || day.date)}</h2>
        <p class="buslijst-day-empty">Geen producten</p>
      </section>`;
    }
    const groupHtml = GROUP_ORDER.filter((g) => Array.isArray(groups[g]) && groups[g].length > 0)
      .map((g) => {
        const lines = groups[g]
          .map((row) => {
            const naam = escHtml(row.naam || 'Onbekend product');
            const klant = escHtml(row.klant || 'Onbekende klant');
            return `<li class="buslijst-line">${naam} — ${klant}</li>`;
          })
          .join('');
        return `<div class="buslijst-group">
          <h3 class="buslijst-group-title">${escHtml(g)}</h3>
          <ul class="buslijst-lines">${lines}</ul>
        </div>`;
      })
      .join('');
    return `<section class="buslijst-day" data-date="${escHtml(day.date)}">
      <h2 class="buslijst-day-title">${escHtml(day.dayLabel || day.date)}</h2>
      ${groupHtml}
    </section>`;
  }

  function renderWeek(payload) {
    const el = document.getElementById('buslijstContent');
    if (!el) return;
    const days = Array.isArray(payload?.days) ? payload.days : [];
    if (!days.length) {
      el.innerHTML = '<p class="buslijst-status">Geen dagen in deze week.</p>';
      return;
    }
    el.innerHTML = days.map((d) => renderDay(d)).join('');
  }

  async function fetchWeek() {
    const seq = ++loadSeq;
    renderLoading();
    setWeekNavLabel();
    writeBuslijstUrl(weekStart);
    try {
      const res = await fetch(
        `/api/buslijst?startDate=${encodeURIComponent(weekStart)}`,
        { cache: 'no-store', headers: { 'X-HK-Auth': authHeader() } }
      );
      const data = await res.json().catch(() => ({}));
      if (seq !== loadSeq) return;
      if (!res.ok) {
        if (res.status === 404) {
          renderError(
            'Buslijst-api is nog niet beschikbaar (stap C). Week-navigatie werkt al; data volgt na deploy van het endpoint.'
          );
          return;
        }
        throw new Error(data.error || `Kon buslijst niet laden (${res.status})`);
      }
      if (data.weekStart && isValidYmd(data.weekStart)) weekStart = data.weekStart;
      setWeekNavLabel();
      writeBuslijstUrl(weekStart);
      renderWeek(data);
    } catch (err) {
      if (seq !== loadSeq) return;
      renderError(String(err?.message || err));
    }
  }

  function shiftWeek(deltaWeeks) {
    weekStart = addDaysYmd(weekStart, deltaWeeks * 7);
    void fetchWeek();
  }

  function bindWeekNav() {
    const prev = document.getElementById('buslijstWeekPrev');
    const next = document.getElementById('buslijstWeekNext');
    if (prev && prev.dataset.hkBuslijstWired !== '1') {
      prev.dataset.hkBuslijstWired = '1';
      prev.addEventListener('click', () => shiftWeek(-1));
    }
    if (next && next.dataset.hkBuslijstWired !== '1') {
      next.dataset.hkBuslijstWired = '1';
      next.addEventListener('click', () => shiftWeek(1));
    }
  }

  function onPopState() {
    if (String(global.plannerSidebarView || '') !== 'buslijst') return;
    const next = readWeekStartFromUrl();
    if (next === weekStart) return;
    weekStart = next;
    void fetchWeek();
  }

  async function render() {
    weekStart = readWeekStartFromUrl();
    bindWeekNav();
    await fetchWeek();
  }

  bindWeekNav();
  global.addEventListener('popstate', onPopState);
  global.HKPlannerBuslijst = { render, getWeekStart: () => weekStart };
})(window);
