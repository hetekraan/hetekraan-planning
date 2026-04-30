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

  const HARD_AD_SPEND = [
    { week: 'W14', spend: 1450, omzet: 6120 },
    { week: 'W15', spend: 1720, omzet: 6840 },
    { week: 'W16', spend: 1610, omzet: 6520 },
    { week: 'W17', spend: 1890, omzet: 7310 },
  ];
  const HARD_TRAFFIC = [
    { week: 'W14', organisch: 420, betaald: 250, direct: 130, email: 40 },
    { week: 'W15', organisch: 450, betaald: 280, direct: 140, email: 55 },
    { week: 'W16', organisch: 438, betaald: 260, direct: 132, email: 52 },
    { week: 'W17', organisch: 462, betaald: 295, direct: 150, email: 60 },
  ];

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
  const kpiState = Object.fromEntries(KPI_DEFS.map((x) => [x.key, { loading: true, error: '', value: '-', delta: '-' }]));
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
    kpiState[key] = { loading: false, error: '', value, delta: `${arrow} ${fmtPct(Math.abs(delta))}${suffix}` };
  }
  function setKpiError(key, message) {
    kpiState[key] = { loading: false, error: message || 'Fout', value: 'Fout', delta: '-' };
  }
  function resetKpisLoading() {
    KPI_DEFS.forEach((x) => {
      kpiState[x.key] = { loading: true, error: '', value: 'Laden...', delta: 'bezig...' };
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
    ctx.fillText(String(message || ''), 12, 22);
  }
  function renderKpis() {
    const el = document.getElementById('analyticsKpis');
    if (!el) return;
    el.style.gridTemplateColumns = 'repeat(4,minmax(0,1fr))';
    el.innerHTML = KPI_DEFS.map((def) => {
      const st = kpiState[def.key] || {};
      const sub = st.error ? `<div class="kpi-sub" style="color:var(--reparatie)">${escHtml(st.error)}</div>` : `<div class="kpi-sub">${escHtml(st.delta || '-')}</div>`;
      return `<div class="panel-card"><div class="kpi-title">${def.title}</div><div class="kpi-value">${escHtml(st.value || '-')}</div>${sub}</div>`;
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
        { label: 'Marge', data: rows.map((x) => Number(x.marge || 0)), borderColor: '#0f7a4b', backgroundColor: 'rgba(15,122,75,.1)', tension: 0.3 },
        { label: 'Installatie', data: rows.map((x) => Number(x.installatie || 0)), borderColor: '#1f2937', tension: 0.25 },
        { label: 'Reparatie', data: rows.map((x) => Number(x.reparatie || 0)), borderColor: '#a855f7', tension: 0.25 },
        { label: 'Onderhoud', data: rows.map((x) => Number(x.onderhoud || 0)), borderColor: '#0891b2', tension: 0.25 },
      ],
    });
  }
  function renderAdSpendSection() {
    drawChart('analyticsAdSpendChart', 'bar', {
      labels: HARD_AD_SPEND.map((x) => x.week),
      datasets: [
        { label: 'Ad spend', data: HARD_AD_SPEND.map((x) => x.spend), backgroundColor: 'rgba(17,24,39,.75)' },
        { label: 'Omzet', data: HARD_AD_SPEND.map((x) => x.omzet), backgroundColor: 'rgba(220,74,26,.75)' },
      ],
    });
    const totalSpend = HARD_AD_SPEND.reduce((s, x) => s + x.spend, 0);
    const totalRevenue = HARD_AD_SPEND.reduce((s, x) => s + x.omzet, 0);
    const roas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
    const meta = document.getElementById('analyticsRoasMeta');
    if (meta) meta.textContent = `ROAS: ${roas.toFixed(2)}x`;
  }
  function renderTrafficSection() {
    drawChart('analyticsTrafficChart', 'line', {
      labels: HARD_TRAFFIC.map((x) => x.week),
      datasets: [
        { label: 'Organisch', data: HARD_TRAFFIC.map((x) => x.organisch), borderColor: '#0f7a4b', tension: 0.25 },
        { label: 'Betaald', data: HARD_TRAFFIC.map((x) => x.betaald), borderColor: '#dc4a1a', tension: 0.25 },
        { label: 'Direct', data: HARD_TRAFFIC.map((x) => x.direct), borderColor: '#111827', tension: 0.25 },
        { label: 'Email', data: HARD_TRAFFIC.map((x) => x.email), borderColor: '#7c3aed', tension: 0.25 },
      ],
    });
    const sessions = HARD_TRAFFIC.reduce((s, x) => s + x.organisch + x.betaald + x.direct + x.email, 0);
    const forms = Math.round(sessions * 0.092);
    const bookings = Number(analyticsData?.kpis?.totaalAfspraken || 0);
    const funnel = document.getElementById('analyticsFunnel');
    if (funnel) {
      const max = Math.max(1, sessions, forms, bookings);
      const row = (label, value, color) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><div style="width:170px;font-size:12px;color:var(--ink-soft)">${label}</div><div style="flex:1;background:#f4efe7;border-radius:6px;height:10px;overflow:hidden"><div style="height:10px;background:${color};width:${Math.max(3, Math.round((value / max) * 100))}%"></div></div><strong style="width:80px;text-align:right;font-size:12px">${value}</strong></div>`;
      funnel.innerHTML = row('Sessies', sessions, '#111827') + row('Contactformulier', forms, '#dc4a1a') + row('Boeking', bookings, '#0f7a4b');
    }
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
    const placeholder = [
      { naam: 'Van Dijk', bedrag: 420, dagenOpen: 18 },
      { naam: 'Familie Bos', bedrag: 690, dagenOpen: 11 },
      { naam: 'Jansen BV', bedrag: 1240, dagenOpen: 27 },
    ];
    openTable.innerHTML = `<thead><tr><th>Naam</th><th>Bedrag</th><th>Dagen open</th></tr></thead><tbody>${placeholder.map((r) => `<tr><td>${escHtml(r.naam)}</td><td>${fmtEuro(r.bedrag)}</td><td>${r.dagenOpen}</td></tr>`).join('')}</tbody>`;
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
      paintCanvasMessage('analyticsOccupancyChart', sectionState.analytics.error);
      paintCanvasMessage('analyticsRevenueByTechChart', sectionState.analytics.error);
      paintCanvasMessage('analyticsJobTypeDonutChart', sectionState.analytics.error);
      const repeat = document.getElementById('analyticsRepeatCustomersKpi');
      if (repeat) repeat.textContent = 'Fout';
      return;
    }
    const totalRevenue = Number(analyticsData?.kpis?.totaleOmzet || 0);
    const totalAppts = Math.max(1, Number(analyticsData?.kpis?.totaalAfspraken || 0));
    const techs = ['Jerry', 'Daan', 'Sander'];
    const revByTech = techs.map((name, i) => ({ name, omzet: Math.round((totalRevenue * [0.38, 0.34, 0.28][i]) * 100) / 100 }));
    const occByTech = techs.map((name, i) => ({ name, bezetting: Math.min(100, Math.round((totalAppts / 3) * [8.5, 7.9, 7.2][i])) }));
    drawChart('analyticsOccupancyChart', 'bar', {
      labels: occByTech.map((x) => x.name),
      datasets: [{ label: 'Bezetting %', data: occByTech.map((x) => x.bezetting), backgroundColor: 'rgba(17,24,39,.75)' }],
    }, { scales: { y: { max: 100 } } });
    drawChart('analyticsRevenueByTechChart', 'bar', {
      labels: revByTech.map((x) => x.name),
      datasets: [{ label: 'Omzet', data: revByTech.map((x) => x.omzet), backgroundColor: 'rgba(220,74,26,.75)' }],
    }, { indexAxis: 'y' });
    const jt = Array.isArray(analyticsData?.jobTypeVerdeling) ? analyticsData.jobTypeVerdeling : [];
    drawChart('analyticsJobTypeDonutChart', 'doughnut', {
      labels: jt.map((x) => x.jobType),
      datasets: [{ data: jt.map((x) => Number(x.aantal || 0)), backgroundColor: ['#111827', '#dc4a1a', '#0f7a4b', '#7c3aed'] }],
    });
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.detail || `Analytics fout (${res.status})`);
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
      let prev = null;
      if (start && end) {
        const dayMs = 24 * 60 * 60 * 1000;
        const diff = Math.max(1, Math.floor((new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / dayMs) + 1);
        const prevEnd = addDaysYmd(start, -1);
        const prevStart = addDaysYmd(prevEnd, -(diff - 1));
        prev = await fetchAnalyticsByQuery(`startDate=${encodeURIComponent(prevStart)}&endDate=${encodeURIComponent(prevEnd)}`);
      } else {
        prev = { kpis: {}, omzetByWeek: [] };
      }
      analyticsData = curr;
      previousData = prev;
      analyticsMeta = curr?.meta || null;
      const k = curr?.kpis || {};
      const p = prev?.kpis || {};
      const totalMargin = (curr?.omzetByWeek || []).reduce((s, x) => s + Number(x.marge || 0), 0);
      const prevMargin = (prev?.omzetByWeek || []).reduce((s, x) => s + Number(x.marge || 0), 0);
      const adSpend = HARD_AD_SPEND.reduce((s, x) => s + x.spend, 0);
      const sessions = HARD_TRAFFIC.reduce((s, x) => s + x.organisch + x.betaald + x.direct + x.email, 0);
      const prevSessions = Math.round(sessions * 0.94);
      const conv = sessions ? (Number(k.totaalAfspraken || 0) / sessions) * 100 : 0;
      const prevConv = prevSessions ? (Number(p.totaalAfspraken || 0) / prevSessions) * 100 : 0;
      setKpi('omzet', fmtEuro(k.totaleOmzet || 0), k.totaleOmzet || 0, p.totaleOmzet || 0);
      setKpi('marge', `${fmtEuro(totalMargin)} · ${fmtPct((k.totaleOmzet ? (totalMargin / k.totaleOmzet) * 100 : 0))}`, totalMargin, prevMargin);
      setKpi('adSpend', fmtEuro(adSpend), adSpend, adSpend * 0.92);
      setKpi('afspraken', String(k.totaalAfspraken || 0), k.totaalAfspraken || 0, p.totaalAfspraken || 0);
      setKpi('sessions', String(sessions), sessions, prevSessions);
      setKpi('conversie', fmtPct(conv), conv, prevConv);
      setKpi('gemWaarde', fmtEuro(k.gemiddeldeWaarde || 0), k.gemiddeldeWaarde || 0, p.gemiddeldeWaarde || 0);
      const gm = k.totaleOmzet ? (totalMargin / k.totaleOmzet) * 100 : 0;
      const pgm = p.totaleOmzet ? (prevMargin / p.totaleOmzet) * 100 : 0;
      setKpi('gemMarge', fmtPct(gm), gm, pgm);
      sectionState.analytics = { loading: false, error: '' };
    } catch (err) {
      const msg = String(err?.message || err);
      sectionState.analytics = { loading: false, error: msg };
      KPI_DEFS.forEach((k) => setKpiError(k.key, msg));
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
