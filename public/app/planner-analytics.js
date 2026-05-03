(function initPlannerAnalytics(global) {
  const KPI_DEFS = [
    { key: 'omzet', title: 'Omzet (periode)' },
    { key: 'marge', title: 'Marge (€ en %)' },
    { key: 'adSpend', title: 'Ad spend' },
    { key: 'afspraken', title: 'Afspraken' },
    { key: 'sessions', title: 'Website sessies' },
    { key: 'conversie', title: 'Conversie %' },
    { key: 'gemWaarde', title: 'Gem. waarde per afspraak' },
    { key: 'gemMarge', title: 'Gem. marge %' },
  ];

  /** KPI’s die uit /api/analytics komen; bij fout alleen deze op “Mislukt” + detail. */
  const KPI_KEYS_FROM_ANALYTICS_API = ['omzet', 'marge', 'afspraken', 'gemWaarde', 'gemMarge'];
  /** Geen echte bron in deze versie — altijd “Niet gekoppeld”, ook als analytics faalt. */
  const KPI_KEYS_NOT_LINKED = ['adSpend', 'sessions', 'conversie'];

  let period = '30d';
  let customStart = '';
  let customEnd = '';
  let analyticsData = null;
  let previousData = null;
  let analyticsMeta = null;
  let cashflowRows = [];
  let inventoryRows = [];
  const sectionState = {
    analytics: { loading: false, error: '' },
    cashflow: { loading: false, error: '' },
    inventory: { loading: false, error: '' },
  };
  const kpiState = Object.fromEntries(
    KPI_DEFS.map((x) => [x.key, { loading: true, error: '', value: '-', delta: '-', notLinked: false }])
  );
  const charts = {};
  let chartJsPromise = null;
  let bootstrapped = false;
  let customPickerOverlay = null;
  let customPickerViewMonth = '';
  let customDraftStart = '';
  let customDraftEnd = '';

  function fmtEuro(n) {
    return `€ ${Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtPct(n) {
    return `${Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }
  function escHtml(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return global.HKPlannerAuthSession?.hkAuthHeader?.({ localStorageImpl: global.localStorage, documentRef: document }) || '';
  }
  function debugEnabled() {
    try {
      const params = new URLSearchParams(global.location?.search || '');
      return params.get('debug') === '1';
    } catch (_) {
      return false;
    }
  }
  function todayYmd() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  }
  function addDaysYmd(ymd, delta) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  function startOfMonthYmd(ymd) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(1);
    return d.toISOString().slice(0, 10);
  }
  function addMonthsYmd(ymd, deltaMonths) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + deltaMonths);
    return d.toISOString().slice(0, 10);
  }
  function monthLabel(ymd) {
    const d = new Date(`${ymd}T12:00:00Z`);
    return d.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  function daysInMonth(ymd) {
    const d = new Date(`${ymd}T12:00:00Z`);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  }
  function weekdayMonFirstOffset(ymd) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(1);
    const wd = d.getUTCDay(); // 0 sun ... 6 sat
    return wd === 0 ? 6 : wd - 1;
  }
  function ymdFromDateParts(year, monthIndex, day) {
    return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
  }
  function isInDraftRange(ymd) {
    if (!customDraftStart || !customDraftEnd) return false;
    return ymd >= customDraftStart && ymd <= customDraftEnd;
  }
  function applyPresetRange(presetId) {
    const today = todayYmd();
    if (presetId === 'today') {
      customDraftStart = today;
      customDraftEnd = today;
      return;
    }
    if (presetId === 'yesterday') {
      const y = addDaysYmd(today, -1);
      customDraftStart = y;
      customDraftEnd = y;
      return;
    }
    if (presetId === 'last7') {
      customDraftEnd = today;
      customDraftStart = addDaysYmd(today, -6);
      return;
    }
    if (presetId === 'last30') {
      customDraftEnd = today;
      customDraftStart = addDaysYmd(today, -29);
      return;
    }
    if (presetId === 'thisMonth') {
      customDraftStart = startOfMonthYmd(today);
      customDraftEnd = today;
      return;
    }
    if (presetId === 'prevMonth') {
      const thisMonthStart = startOfMonthYmd(today);
      const prevMonthStart = addMonthsYmd(thisMonthStart, -1);
      const thisMonthStartDate = new Date(`${thisMonthStart}T12:00:00Z`);
      const prevMonthEndDate = new Date(thisMonthStartDate.getTime() - 24 * 60 * 60 * 1000);
      customDraftStart = prevMonthStart;
      customDraftEnd = prevMonthEndDate.toISOString().slice(0, 10);
    }
  }
  function buildRangeQuery(inputPeriod, isPrevious = false) {
    if (inputPeriod === 'custom') {
      const s = customStart || todayYmd();
      const e = customEnd || s;
      if (!isPrevious) return `startDate=${encodeURIComponent(s)}&endDate=${encodeURIComponent(e)}`;
      const dayMs = 24 * 60 * 60 * 1000;
      const diff = Math.max(1, Math.floor((new Date(`${e}T12:00:00Z`) - new Date(`${s}T12:00:00Z`)) / dayMs) + 1);
      const prevEnd = addDaysYmd(s, -1);
      const prevStart = addDaysYmd(prevEnd, -(diff - 1));
      return `startDate=${encodeURIComponent(prevStart)}&endDate=${encodeURIComponent(prevEnd)}`;
    }
    if (inputPeriod === 'today') {
      const t = todayYmd();
      if (!isPrevious) return `startDate=${encodeURIComponent(t)}&endDate=${encodeURIComponent(t)}`;
      const p = addDaysYmd(t, -1);
      return `startDate=${encodeURIComponent(p)}&endDate=${encodeURIComponent(p)}`;
    }
    if (!isPrevious) return `period=${encodeURIComponent(inputPeriod)}`;
    const prevMap = { '7d': '7d', '30d': '30d', kwartaal: 'kwartaal', jaar: 'jaar' };
    return `period=${encodeURIComponent(prevMap[inputPeriod] || '30d')}&_prev=1`;
  }
  function comparePct(curr, prev) {
    const c = Number(curr || 0);
    const p = Number(prev || 0);
    if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return 0;
    return ((c - p) / Math.abs(p)) * 100;
  }
  function setKpi(key, value, curr, prev, suffix = '') {
    const delta = comparePct(curr, prev);
    const arrow = delta >= 0 ? '↑' : '↓';
    kpiState[key] = {
      loading: false,
      error: '',
      value,
      delta: `${arrow} ${fmtPct(Math.abs(delta))}${suffix}`,
      notLinked: false,
    };
  }
  function kpiNotLinkedState(key) {
    const hints = {
      adSpend: 'Google Ads-API is nog niet gekoppeld.',
      sessions: 'GA4 / WordPress-sessiedata nog niet gekoppeld.',
      conversie: 'Zonder echte sessiedata is conversie niet zinvol.',
    };
    return {
      loading: false,
      error: '',
      value: 'Niet gekoppeld',
      delta: hints[key] || 'Nog niet gekoppeld.',
      notLinked: true,
    };
  }
  function setAnalyticsApiKpisError(message) {
    const raw = String(message || 'Onbekende fout').trim();
    const truncated = raw.length > 520 ? `${raw.slice(0, 520)}…` : raw;
    KPI_KEYS_FROM_ANALYTICS_API.forEach((key) => {
      kpiState[key] = {
        loading: false,
        error: truncated,
        value: 'Mislukt',
        delta: '—',
        notLinked: false,
      };
    });
  }
  function resetKpisLoading() {
    KPI_DEFS.forEach((x) => {
      if (KPI_KEYS_NOT_LINKED.includes(x.key)) {
        kpiState[x.key] = kpiNotLinkedState(x.key);
      } else {
        kpiState[x.key] = { loading: true, error: '', value: 'Laden…', delta: 'Bezig…', notLinked: false };
      }
    });
  }

  async function ensureChartJs() {
    if (global.Chart) return global.Chart;
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
      s.async = true;
      s.onload = () => resolve(global.Chart);
      s.onerror = () => reject(new Error('Chart.js laden mislukt'));
      document.head.appendChild(s);
    });
    return chartJsPromise;
  }
  function drawChart(id, type, data, options = {}) {
    const canvas = document.getElementById(id);
    if (!canvas || !global.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new global.Chart(canvas, {
      type,
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' } },
        ...options,
      },
    });
  }
  function paintCanvasMessage(id, message) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8e867c';
    ctx.font = '12px Inter, sans-serif';
    const text = String(message || '').trim();
    const maxW = Math.max(80, (canvas.width || 300) - 24);
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const tryLine = line ? `${line} ${w}` : w;
      if (ctx.measureText(tryLine).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = tryLine;
      }
    }
    if (line) lines.push(line);
    const toDraw = lines.length ? lines.slice(0, 5) : [''];
    let y = 20;
    for (const ln of toDraw) {
      ctx.fillText(ln.slice(0, 120), 12, y);
      y += 16;
    }
  }
  function destroyChartIf(id) {
    if (charts[id]) {
      try {
        charts[id].destroy();
      } catch (_) {}
      delete charts[id];
    }
  }
  function renderKpis() {
    const el = document.getElementById('analyticsKpis');
    if (!el) return;
    el.style.gridTemplateColumns = 'repeat(4,minmax(0,1fr))';
    el.innerHTML = KPI_DEFS.map((def) => {
      const st = kpiState[def.key] || {};
      let sub = '';
      if (st.loading) {
        sub = `<div class="kpi-sub">${escHtml(st.delta || '')}</div>`;
      } else if (st.notLinked) {
        sub = `<div class="kpi-sub" style="color:var(--ink-muted);font-size:11px;line-height:1.4">${escHtml(st.delta || '')}</div>`;
      } else if (st.error) {
        sub = `<div class="kpi-sub" style="color:var(--reparatie);font-size:11px;line-height:1.45;word-break:break-word">${escHtml(st.error)}</div>`;
      } else {
        sub = `<div class="kpi-sub">${escHtml(st.delta || '—')}</div>`;
      }
      const valStyle =
        st.notLinked || st.error
          ? 'color:var(--ink-muted);font-size:clamp(15px,2.2vw,18px)'
          : 'font-size:clamp(16px,2.4vw,20px)';
      return `<div class="panel-card"><div class="kpi-title">${def.title}</div><div class="kpi-value" style="${valStyle}">${escHtml(st.value || '—')}</div>${sub}</div>`;
    }).join('');
  }
  function renderDebugMeta() {
    const panel = document.getElementById('panelAnalytics');
    if (!panel) return;
    let el = document.getElementById('analyticsDebugMeta');
    if (!debugEnabled()) {
      if (el?.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'analyticsDebugMeta';
      el.className = 'panel-card';
      el.style.fontSize = '11px';
      el.style.color = 'var(--ink-muted)';
      el.style.margin = '0 0 14px';
      panel.querySelector('.panel-page-content')?.appendChild(el);
    }
    const m = analyticsMeta || {};
    el.textContent = `debug · period=${m.period || '-'} · ghlCalls=${m.ghlCalls ?? '-'} · uniqueContacts=${m.uniqueContacts ?? '-'} · cacheHit=${m.cacheHit || '-'} · generatedAt=${m.generatedAt || '-'}`;
  }
  function renderRevenueMarginSection() {
    if (sectionState.analytics.error) {
      paintCanvasMessage('analyticsRevenueMarginChart', sectionState.analytics.error);
      return;
    }
    const rows = Array.isArray(analyticsData?.omzetByWeek) ? analyticsData.omzetByWeek : [];
    drawChart('analyticsRevenueMarginChart', 'line', {
      labels: rows.map((x) => x.week),
      datasets: [
        { label: 'Omzet', data: rows.map((x) => Number(x.omzet || 0)), borderColor: '#dc4a1a', backgroundColor: 'rgba(220,74,26,.1)', tension: 0.3 },
        { label: 'Marge (geschat)', data: rows.map((x) => Number(x.marge || 0)), borderColor: '#0f7a4b', backgroundColor: 'rgba(15,122,75,.1)', tension: 0.3 },
        { label: 'Installatie', data: rows.map((x) => Number(x.installatie || 0)), borderColor: '#1f2937', tension: 0.25 },
        { label: 'Reparatie', data: rows.map((x) => Number(x.reparatie || 0)), borderColor: '#a855f7', tension: 0.25 },
        { label: 'Onderhoud', data: rows.map((x) => Number(x.onderhoud || 0)), borderColor: '#0891b2', tension: 0.25 },
      ],
    });
  }
  function renderAdSpendSection() {
    destroyChartIf('analyticsAdSpendChart');
    paintCanvasMessage(
      'analyticsAdSpendChart',
      'Advertentie-data: niet gekoppeld (geen demo-grafiek). Koppel later Google Ads om spend en ROAS te tonen.'
    );
    const meta = document.getElementById('analyticsRoasMeta');
    if (meta) meta.textContent = 'ROAS: niet van toepassing (geen ad spend-bron)';
  }
  function renderTrafficFunnelPlaceholder(errorText) {
    const funnel = document.getElementById('analyticsFunnel');
    if (!funnel) return;
    if (errorText) {
      funnel.innerHTML = `<div class="panel-card" style="padding:14px;border:1px solid var(--border);border-radius:10px;background:#fff8f5"><strong style="color:var(--text)">Website → afspraken</strong><p style="margin:8px 0 0;font-size:13px;color:var(--reparatie);line-height:1.45;word-break:break-word">${escHtml(errorText)}</p></div>`;
      return;
    }
    funnel.innerHTML = `<div class="panel-card" style="padding:14px;border:1px solid var(--border);border-radius:10px;background:#fdfbf8;font-size:13px;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--text)">Website → afspraken</strong><p style="margin:8px 0 0">GA4 en/of WordPress-analytics zijn <strong>nog niet gekoppeld</strong>. Hier komt straks het funnel-overzicht (sessies → formulier → boeking).</p><p style="margin:10px 0 0;font-size:12px;color:var(--ink-muted)">Het aantal <strong>afspraken</strong> in de KPI-rij komt uit de planning (GHL), niet uit deze funnel.</p></div>`;
  }
  function renderTrafficSection() {
    destroyChartIf('analyticsTrafficChart');
    if (sectionState.analytics.error) {
      paintCanvasMessage('analyticsTrafficChart', sectionState.analytics.error);
      renderTrafficFunnelPlaceholder(sectionState.analytics.error);
      return;
    }
    paintCanvasMessage(
      'analyticsTrafficChart',
      'Geen sessiedata: koppel GA4 of een WordPress/website-bron om verkeer te tonen.'
    );
    renderTrafficFunnelPlaceholder('');
  }
  function renderCashflowSection() {
    if (sectionState.cashflow.error) {
      paintCanvasMessage('analyticsCashflowChart', sectionState.cashflow.error);
      const openTable = document.getElementById('analyticsOpenInvoicesTable');
      if (openTable) openTable.innerHTML = `<tbody><tr><td style="color:var(--reparatie)">${escHtml(sectionState.cashflow.error)}</td></tr></tbody>`;
      return;
    }
    drawChart('analyticsCashflowChart', 'bar', {
      labels: cashflowRows.map((x) => x.maand),
      datasets: [
        { label: 'Inkomsten', data: cashflowRows.map((x) => Number(x.inkomsten || 0)), backgroundColor: 'rgba(15,122,75,.75)' },
        { label: 'Kosten', data: cashflowRows.map((x) => Number(x.kosten || 0)), backgroundColor: 'rgba(220,74,26,.65)' },
        { type: 'line', label: 'Netto', data: cashflowRows.map((x) => Number(x.netto || 0)), borderColor: '#111827', yAxisID: 'y' },
      ],
    });
    const openTable = document.getElementById('analyticsOpenInvoicesTable');
    if (!openTable) return;
    openTable.innerHTML = `<tbody><tr><td colspan="3" style="padding:14px;font-size:13px;color:var(--ink-soft);line-height:1.45;border:none"><strong style="color:var(--text)">Openstaande facturen (detail)</strong> — nog niet gekoppeld. De cashflow-grafiek hierboven gebruikt wel Moneybird op maandniveau wanneer de API beschikbaar is.</td></tr></tbody>`;
  }
  function renderInventorySection() {
    const el = document.getElementById('analyticsInventoryTable');
    if (!el) return;
    if (sectionState.inventory.loading) {
      el.innerHTML = '<tbody><tr><td>Voorraad laden...</td></tr></tbody>';
      return;
    }
    if (sectionState.inventory.error) {
      el.innerHTML = `<tbody><tr><td style="color:var(--reparatie)">${escHtml(sectionState.inventory.error)}</td></tr></tbody>`;
      return;
    }
    const rows = inventoryRows.filter((x) => Number(x.stock) <= 0 || Number(x.stock) < Number(x.minStock || 0));
    el.innerHTML = `<thead><tr><th>Naam</th><th>Categorie</th><th>Voorraad</th><th>Minimum</th><th>Status</th></tr></thead><tbody>${rows.map((r) => {
      const st = Number(r.stock) <= 0 ? 'Uitverkocht' : 'Laag';
      return `<tr><td>${escHtml(r.name || '-')}</td><td>${escHtml(r.category || '-')}</td><td>${Number(r.stock || 0)}</td><td>${Number(r.minStock || 0)}</td><td>${st}</td></tr>`;
    }).join('')}</tbody>`;
  }
  function renderRecentAppointments() {
    const el = document.getElementById('analyticsRecentAppointmentsTable');
    if (!el) return;
    if (sectionState.analytics.loading) {
      el.innerHTML = '<tbody><tr><td>Afspraken laden...</td></tr></tbody>';
      return;
    }
    if (sectionState.analytics.error) {
      el.innerHTML = `<tbody><tr><td style="color:var(--reparatie)">${escHtml(sectionState.analytics.error)}</td></tr></tbody>`;
      return;
    }
    const rows = Array.isArray(analyticsData?.recentAppointments) ? analyticsData.recentAppointments : [];
    el.innerHTML = `<thead><tr><th>Datum</th><th>Klant</th><th>Adres</th><th>Werksoort</th><th>Bedrag</th><th>Status</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escHtml(r.datum || '-')}</td><td>${escHtml(r.klant || '-')}</td><td>${escHtml(r.adres || '-')}</td><td>${escHtml(r.werksoort || '-')}</td><td>${fmtEuro(r.bedrag || 0)}</td><td>${escHtml(r.status || '-')}</td></tr>`).join('')}</tbody>`;
  }
  function renderOperationalSection() {
    if (sectionState.analytics.error) {
      destroyChartIf('analyticsOccupancyChart');
      destroyChartIf('analyticsRevenueByTechChart');
      destroyChartIf('analyticsJobTypeDonutChart');
      paintCanvasMessage('analyticsOccupancyChart', sectionState.analytics.error);
      paintCanvasMessage('analyticsRevenueByTechChart', sectionState.analytics.error);
      paintCanvasMessage('analyticsJobTypeDonutChart', sectionState.analytics.error);
      const repeat = document.getElementById('analyticsRepeatCustomersKpi');
      if (repeat) repeat.textContent = '—';
      return;
    }
    destroyChartIf('analyticsOccupancyChart');
    destroyChartIf('analyticsRevenueByTechChart');
    paintCanvasMessage(
      'analyticsOccupancyChart',
      'Bezetting per monteur: nog niet gekoppeld (geen uren- of routebron in analytics).'
    );
    paintCanvasMessage(
      'analyticsRevenueByTechChart',
      'Omzet per monteur: nog niet gekoppeld (geen toewijzing van omzet aan monteur).'
    );
    const jt = Array.isArray(analyticsData?.jobTypeVerdeling) ? analyticsData.jobTypeVerdeling : [];
    if (!jt.length) {
      destroyChartIf('analyticsJobTypeDonutChart');
      paintCanvasMessage('analyticsJobTypeDonutChart', 'Geen werksoorten in deze periode.');
    } else {
      drawChart('analyticsJobTypeDonutChart', 'doughnut', {
        labels: jt.map((x) => x.jobType),
        datasets: [{ data: jt.map((x) => Number(x.aantal || 0)), backgroundColor: ['#111827', '#dc4a1a', '#0f7a4b', '#7c3aed'] }],
      });
    }
    const repeat = document.getElementById('analyticsRepeatCustomersKpi');
    if (repeat) repeat.textContent = fmtPct(analyticsData?.repeatCustomersPct || 0);
  }

  function renderPeriodFilters() {
    const el = document.getElementById('analyticsPeriodFilters');
    if (!el) return;
    const opts = [
      ['today', 'Vandaag'],
      ['7d', '7d'],
      ['30d', '30d'],
      ['kwartaal', 'Kwartaal'],
      ['jaar', 'Jaar'],
      ['custom', 'Aangepast'],
    ];
    el.innerHTML = opts.map(([id, label]) => `<button type="button" class="chip-btn ${period === id ? 'is-active' : ''}" data-period="${id}">${label}</button>`).join('');
    el.querySelectorAll('[data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-period') || '30d';
        if (next === 'custom') {
          openCustomRangePicker();
          return;
        }
        period = next;
        renderPeriodFilters();
        void loadAllSections();
      });
    });
  }

  function selectDraftDate(ymd) {
    if (!customDraftStart || (customDraftStart && customDraftEnd)) {
      customDraftStart = ymd;
      customDraftEnd = '';
      return;
    }
    if (ymd < customDraftStart) {
      customDraftEnd = customDraftStart;
      customDraftStart = ymd;
      return;
    }
    customDraftEnd = ymd;
  }
  function renderMonthGrid(monthStartYmd) {
    const d = new Date(`${monthStartYmd}T12:00:00Z`);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const total = daysInMonth(monthStartYmd);
    const offset = weekdayMonFirstOffset(monthStartYmd);
    const cells = [];
    for (let i = 0; i < offset; i += 1) cells.push('<div></div>');
    for (let day = 1; day <= total; day += 1) {
      const ymd = ymdFromDateParts(year, month, day);
      const isStart = ymd === customDraftStart;
      const isEnd = ymd === customDraftEnd;
      const inRange = isInDraftRange(ymd);
      const style = [
        'border:none',
        'height:32px',
        'border-radius:8px',
        'cursor:pointer',
        'font-size:12px',
        inRange ? 'background:#dbeafe' : 'background:transparent',
        (isStart || isEnd) ? 'background:#2563eb;color:#fff;font-weight:600' : '',
      ].join(';');
      cells.push(`<button type="button" data-ymd="${ymd}" style="${style}">${day}</button>`);
    }
    return `
      <div style="min-width:240px">
        <div style="font-weight:600;margin-bottom:8px;text-transform:capitalize">${monthLabel(monthStartYmd)}</div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;font-size:11px;color:var(--ink-muted);margin-bottom:6px">
          <div>Ma</div><div>Di</div><div>Wo</div><div>Do</div><div>Vr</div><div>Za</div><div>Zo</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">${cells.join('')}</div>
      </div>
    `;
  }
  function closeCustomRangePicker() {
    if (customPickerOverlay?.parentNode) customPickerOverlay.parentNode.removeChild(customPickerOverlay);
    customPickerOverlay = null;
  }
  function renderCustomRangePickerBody() {
    if (!customPickerOverlay) return;
    const body = customPickerOverlay.querySelector('[data-picker-body]');
    if (!body) return;
    const firstMonth = customPickerViewMonth;
    const secondMonth = addMonthsYmd(firstMonth, 1);
    const rangeLabel = customDraftStart && customDraftEnd
      ? `${customDraftStart} t/m ${customDraftEnd}`
      : (customDraftStart ? `${customDraftStart} gekozen` : 'Kies een start- en einddatum');
    body.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button type="button" class="chip-btn" data-preset="today">Vandaag</button>
        <button type="button" class="chip-btn" data-preset="yesterday">Gisteren</button>
        <button type="button" class="chip-btn" data-preset="last7">Laatste 7 dagen</button>
        <button type="button" class="chip-btn" data-preset="last30">Laatste 30 dagen</button>
        <button type="button" class="chip-btn" data-preset="thisMonth">Deze maand</button>
        <button type="button" class="chip-btn" data-preset="prevMonth">Vorige maand</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <button type="button" class="chip-btn" data-nav="-1">←</button>
        <div class="kpi-sub">${escHtml(rangeLabel)}</div>
        <button type="button" class="chip-btn" data-nav="1">→</button>
      </div>
      <div style="display:flex;gap:16px;align-items:flex-start">${renderMonthGrid(firstMonth)}${renderMonthGrid(secondMonth)}</div>
    `;
    body.querySelectorAll('[data-ymd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectDraftDate(btn.getAttribute('data-ymd') || '');
        renderCustomRangePickerBody();
      });
    });
    body.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPresetRange(btn.getAttribute('data-preset') || '');
        if (customDraftStart) customPickerViewMonth = startOfMonthYmd(customDraftStart);
        renderCustomRangePickerBody();
      });
    });
    body.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = Number(btn.getAttribute('data-nav') || '0');
        customPickerViewMonth = addMonthsYmd(customPickerViewMonth, step);
        renderCustomRangePickerBody();
      });
    });
    const apply = customPickerOverlay?.querySelector('[data-apply-picker]');
    if (apply) apply.disabled = !(customDraftStart && customDraftEnd);
  }
  function openCustomRangePicker() {
    closeCustomRangePicker();
    if (!customStart || !customEnd) {
      customEnd = todayYmd();
      customStart = addDaysYmd(customEnd, -29);
    }
    customDraftStart = customStart;
    customDraftEnd = customEnd;
    customPickerViewMonth = startOfMonthYmd(customDraftStart || todayYmd());
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:860px;width:min(92vw,860px)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="modal-title" style="margin:0">Aangepaste periode</div>
          <button type="button" class="btn-cancel" data-close-picker>✕</button>
        </div>
        <div data-picker-body></div>
        <div class="modal-actions" style="margin-top:14px">
          <button type="button" class="btn-cancel" data-close-picker>Annuleren</button>
          <button type="button" class="btn-save" data-apply-picker ${customDraftStart && customDraftEnd ? '' : 'disabled'}>Toepassen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    customPickerOverlay = overlay;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeCustomRangePicker();
    });
    overlay.querySelectorAll('[data-close-picker]').forEach((btn) => btn.addEventListener('click', closeCustomRangePicker));
    overlay.querySelector('[data-apply-picker]')?.addEventListener('click', () => {
      if (!customDraftStart || !customDraftEnd) return;
      customStart = customDraftStart;
      customEnd = customDraftEnd;
      period = 'custom';
      closeCustomRangePicker();
      renderPeriodFilters();
      void loadAllSections();
    });
    renderCustomRangePickerBody();
  }

  async function fetchAnalyticsByQuery(query) {
    const res = await fetch(`/api/analytics?${query}`, { cache: 'no-store', headers: { 'X-HK-Auth': authHeader() } });
    const text = await res.text().catch(() => '');
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = {};
    }
    if (!res.ok || data?.ok === false) {
      const errTitle = data?.error || `HTTP ${res.status}`;
      const detail = data?.detail ? String(data.detail).trim() : '';
      const tail = !detail && text && text.trim().startsWith('{') === false ? text.trim().slice(0, 200) : '';
      const full = [errTitle, detail || tail].filter(Boolean).join(' — ');
      throw new Error(full || `Analytics (${res.status})`);
    }
    return data;
  }
  async function loadAnalyticsSection() {
    sectionState.analytics = { loading: true, error: '' };
    resetKpisLoading();
    renderKpis();
    renderRecentAppointments();
    try {
      const curr = await fetchAnalyticsByQuery(buildRangeQuery(period, false));
      const start = String(curr?.startDate || '');
      const end = String(curr?.endDate || '');
      let prev = { kpis: {}, omzetByWeek: [] };
      if (start && end) {
        const dayMs = 24 * 60 * 60 * 1000;
        const diff = Math.max(1, Math.floor((new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / dayMs) + 1);
        const prevEnd = addDaysYmd(start, -1);
        const prevStart = addDaysYmd(prevEnd, -(diff - 1));
        try {
          prev = await fetchAnalyticsByQuery(`startDate=${encodeURIComponent(prevStart)}&endDate=${encodeURIComponent(prevEnd)}`);
        } catch (_) {
          prev = { kpis: {}, omzetByWeek: [] };
        }
      }
      analyticsData = curr;
      previousData = prev;
      analyticsMeta = curr?.meta || null;
      const k = curr?.kpis || {};
      const p = prev?.kpis || {};
      const totalMargin = (curr?.omzetByWeek || []).reduce((s, x) => s + Number(x.marge || 0), 0);
      const prevMargin = (prev?.omzetByWeek || []).reduce((s, x) => s + Number(x.marge || 0), 0);
      const margePct = k.totaleOmzet ? (totalMargin / k.totaleOmzet) * 100 : 0;
      setKpi('omzet', fmtEuro(k.totaleOmzet || 0), k.totaleOmzet || 0, p.totaleOmzet || 0);
      setKpi(
        'marge',
        `${fmtEuro(totalMargin)} · ${fmtPct(margePct)}`,
        totalMargin,
        prevMargin,
        ' · geschat (model)'
      );
      KPI_KEYS_NOT_LINKED.forEach((key) => {
        kpiState[key] = kpiNotLinkedState(key);
      });
      setKpi('afspraken', String(k.totaalAfspraken || 0), k.totaalAfspraken || 0, p.totaalAfspraken || 0);
      setKpi('gemWaarde', fmtEuro(k.gemiddeldeWaarde || 0), k.gemiddeldeWaarde || 0, p.gemiddeldeWaarde || 0);
      const gm = k.totaleOmzet ? (totalMargin / k.totaleOmzet) * 100 : 0;
      const pgm = p.totaleOmzet ? (prevMargin / p.totaleOmzet) * 100 : 0;
      setKpi('gemMarge', fmtPct(gm), gm, pgm, ' · geschat');
      sectionState.analytics = { loading: false, error: '' };
    } catch (err) {
      const msg = String(err?.message || err);
      sectionState.analytics = { loading: false, error: msg };
      setAnalyticsApiKpisError(msg);
      KPI_KEYS_NOT_LINKED.forEach((key) => {
        kpiState[key] = kpiNotLinkedState(key);
      });
    }
    renderKpis();
    renderDebugMeta();
    renderRecentAppointments();
  }
  async function loadCashflowSection() {
    sectionState.cashflow = { loading: true, error: '' };
    try {
      const res = await fetch('/api/cashflow', { cache: 'no-store', headers: { 'X-HK-Auth': authHeader() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.detail || `Cashflow fout (${res.status})`);
      cashflowRows = Array.isArray(data?.items) ? data.items : [];
      sectionState.cashflow = { loading: false, error: '' };
    } catch (err) {
      sectionState.cashflow = { loading: false, error: String(err?.message || err) };
    }
    renderCashflowSection();
  }
  async function loadInventorySection() {
    sectionState.inventory = { loading: true, error: '' };
    renderInventorySection();
    try {
      const res = await fetch('/api/inventory', { cache: 'no-store', headers: { 'X-HK-Auth': authHeader() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Voorraad fout (${res.status})`);
      inventoryRows = Array.isArray(data?.items) ? data.items : [];
      sectionState.inventory = { loading: false, error: '' };
    } catch (err) {
      sectionState.inventory = { loading: false, error: String(err?.message || err) };
    }
    renderInventorySection();
  }
  async function loadAllSections() {
    await ensureChartJs().catch(() => {});
    await Promise.all([loadAnalyticsSection(), loadCashflowSection(), loadInventorySection()]);
    renderRevenueMarginSection();
    renderAdSpendSection();
    renderTrafficSection();
    renderCashflowSection();
    renderOperationalSection();
  }
  function render() {
    renderPeriodFilters();
    renderKpis();
    renderInventorySection();
    renderRecentAppointments();
    if (!bootstrapped) {
      bootstrapped = true;
      void loadAllSections();
    }
  }

  global.HKPlannerAnalytics = { render };
})(window);
