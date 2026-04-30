(function initPlannerAnalytics(global) {
  let period = '30d';
  let analyticsLoading = false;
  let analyticsError = '';
  let analyticsData = null;
  let analyticsMeta = null;
  let cashflowRows = [];
  let cashflowLoading = false;
  let cashflowError = '';
  let cashflowLoaded = false;

  const DATA = {
    revenueWeekly: [
      { week: 'W14', installatie: 2100, reparatie: 1700, onderhoud: 920 },
      { week: 'W15', installatie: 2300, reparatie: 1600, onderhoud: 860 },
      { week: 'W16', installatie: 1900, reparatie: 1800, onderhoud: 980 },
      { week: 'W17', installatie: 2500, reparatie: 1750, onderhoud: 1020 },
    ],
    technicians: [
      { name: 'Jerry de Monteur', afspraken: 31, omzet: 8240 },
      { name: 'Daan Service', afspraken: 27, omzet: 6940 },
      { name: 'Sander Installatie', afspraken: 22, omzet: 7560 },
    ],
    wpVsBookings: [
      { week: 'W14', visitors: 840, bookings: 12 },
      { week: 'W15', visitors: 910, bookings: 14 },
      { week: 'W16', visitors: 780, bookings: 10 },
      { week: 'W17', visitors: 990, bookings: 17 },
    ],
  };

  function fmtEuro(n) {
    return `€ ${Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function renderKpis() {
    const el = document.getElementById('analyticsKpis');
    if (!el) return;
    if (analyticsLoading) {
      el.innerHTML = [
        ['Totale omzet', 'Laden...', 'gegevens worden opgehaald'],
        ['Afspraken', 'Laden...', 'gegevens worden opgehaald'],
        ['Gem. waarde', 'Laden...', 'gegevens worden opgehaald'],
        ['Open te factureren', 'Laden...', 'gegevens worden opgehaald'],
      ]
        .map(([t, v, s]) => `<div class="panel-card"><div class="kpi-title">${t}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`)
        .join('');
      return;
    }
    if (analyticsError) {
      el.innerHTML = [
        ['Totale omzet', 'Fout', analyticsError],
        ['Afspraken', 'Fout', analyticsError],
        ['Gem. waarde', 'Fout', analyticsError],
        ['Open te factureren', 'Fout', analyticsError],
      ]
        .map(([t, v, s]) => `<div class="panel-card"><div class="kpi-title">${t}</div><div class="kpi-value">${v}</div><div class="kpi-sub" style="color:var(--reparatie)">${s}</div></div>`)
        .join('');
      return;
    }
    const k = analyticsData?.kpis || {
      totaleOmzet: 0,
      totaalAfspraken: 0,
      gemiddeldeWaarde: 0,
      openstaandTeFactureren: 0,
    };
    el.innerHTML = [
      ['Totale omzet', fmtEuro(k.totaleOmzet), 'in geselecteerde periode'],
      ['Afspraken', String(k.totaalAfspraken), 'uitgevoerde afspraken'],
      ['Gem. waarde', fmtEuro(k.gemiddeldeWaarde), 'per afspraak'],
      ['Open te factureren', fmtEuro(k.openstaandTeFactureren), 'nog te versturen'],
    ]
      .map(([t, v, s]) => `<div class="panel-card"><div class="kpi-title">${t}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`)
      .join('');
  }

  function renderBarChart(targetId, rows, valueFn) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const max = Math.max(1, ...rows.map((r) => valueFn(r)));
    el.innerHTML = rows
      .map((r) => {
        const v = valueFn(r);
        const w = Math.max(3, Math.round((v / max) * 100));
        return `<div class="bar-row"><span>${r.week || r.month}</span><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><strong>${v}</strong></div>`;
      })
      .join('');
  }

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return global.HKPlannerAuthSession?.hkAuthHeader?.({ localStorageImpl: global.localStorage, documentRef: document }) || '';
  }

  function renderRevenueBreakdown() {
    const el = document.getElementById('analyticsRevenueChart');
    if (!el) return;
    const rows = Array.isArray(analyticsData?.jobTypeVerdeling) && analyticsData.jobTypeVerdeling.length
      ? analyticsData.jobTypeVerdeling.map((x) => ({
          week: String(x.jobType || '').slice(0, 1).toUpperCase() + String(x.jobType || '').slice(1),
          installatie: x.jobType === 'installatie' ? Number(x.omzet || 0) : 0,
          reparatie: x.jobType === 'reparatie' ? Number(x.omzet || 0) : 0,
          onderhoud: x.jobType === 'onderhoud' ? Number(x.omzet || 0) : 0,
        }))
      : DATA.revenueWeekly;
    const max = Math.max(1, ...rows.map((r) => r.installatie + r.reparatie + r.onderhoud));
    el.innerHTML = rows
      .map((r) => {
        const total = r.installatie + r.reparatie + r.onderhoud;
        const wi = Math.round((r.installatie / max) * 100);
        const wr = Math.round((r.reparatie / max) * 100);
        const wo = Math.round((r.onderhoud / max) * 100);
        return `<div class="bar-row"><span>${r.week}</span><div class="bar-track" style="display:flex;height:12px"><div style="width:${wi}%;background:#111"></div><div style="width:${wr}%;background:var(--accent)"></div><div style="width:${wo}%;background:var(--green)"></div></div><strong>${fmtEuro(total)}</strong></div>`;
      })
      .join('');
  }

  function renderTechTable() {
    const el = document.getElementById('analyticsTechTable');
    if (!el) return;
    el.innerHTML = `<thead><tr><th>Monteur</th><th>Afspraken</th><th>Omzet</th><th>Gemiddeld</th></tr></thead><tbody>${
      DATA.technicians
        .map((r) => `<tr><td>${r.name}</td><td>${r.afspraken}</td><td>${fmtEuro(r.omzet)}</td><td>${fmtEuro(r.omzet / Math.max(1, r.afspraken))}</td></tr>`)
        .join('')
    }</tbody>`;
  }

  function debugEnabled() {
    try {
      const params = new URLSearchParams(global.location?.search || '');
      return params.get('debug') === '1';
    } catch (_) {
      return false;
    }
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
      el.style.margin = '0 28px 14px';
      panel.appendChild(el);
    }
    const m = analyticsMeta || {};
    el.textContent = `debug · period=${m.period || '-'} · ghlCalls=${m.ghlCalls ?? '-'} · uniqueContacts=${m.uniqueContacts ?? '-'} · cacheHit=${m.cacheHit || '-'} · generatedAt=${m.generatedAt || '-'}`;
  }

  function renderCashflowBlock() {
    const el = document.getElementById('analyticsCashflowChart');
    if (!el) return;
    if (cashflowLoading) {
      el.innerHTML = '<div class="kpi-sub">Cashflow laden...</div>';
      return;
    }
    if (cashflowError) {
      el.innerHTML = `<div class="kpi-sub" style="color:var(--reparatie)">${cashflowError}</div>`;
      return;
    }
    if (!cashflowRows.length) {
      el.innerHTML = '<div class="kpi-sub">Geen cashflow-data beschikbaar.</div>';
      return;
    }
    renderBarChart(
      'analyticsCashflowChart',
      cashflowRows.map((r) => ({ month: r.maand, value: r.netto })),
      (r) => Number(r.value || 0)
    );
  }

  async function loadCashflow() {
    cashflowLoading = true;
    cashflowError = '';
    renderCashflowBlock();
    try {
      const res = await fetch('/api/cashflow', {
        cache: 'no-store',
        headers: { 'X-HK-Auth': authHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Cashflow fout (${res.status})`);
      }
      cashflowRows = Array.isArray(data?.items) ? data.items : [];
      cashflowLoaded = true;
    } catch (err) {
      cashflowError = String(err?.message || err);
    } finally {
      cashflowLoading = false;
      renderCashflowBlock();
    }
  }

  function periodToApiPeriod(p) {
    if (p === '7d') return '7d';
    if (p === 'kwartaal') return 'kwartaal';
    if (p === 'jaar') return 'jaar';
    return '30d';
  }

  async function loadAnalytics() {
    analyticsLoading = true;
    analyticsError = '';
    renderKpis();
    try {
      const apiPeriod = periodToApiPeriod(period);
      const res = await fetch(`/api/analytics?period=${encodeURIComponent(apiPeriod)}`, {
        cache: 'no-store',
        headers: { 'X-HK-Auth': authHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Analytics fout (${res.status})`);
      }
      analyticsData = data;
      analyticsMeta = data?.meta || null;
    } catch (err) {
      analyticsError = String(err?.message || err);
      analyticsMeta = null;
    } finally {
      analyticsLoading = false;
      renderKpis();
      renderRevenueBreakdown();
      renderDebugMeta();
    }
  }

  function renderPeriodFilters() {
    const el = document.getElementById('analyticsPeriodFilters');
    if (!el) return;
    const opts = [
      ['7d', '7 dagen'],
      ['30d', '30 dagen'],
      ['kwartaal', 'Kwartaal'],
      ['jaar', 'Jaar'],
    ];
    el.innerHTML = opts
      .map(([id, label]) => `<button type="button" class="chip-btn ${period === id ? 'is-active' : ''}" data-period="${id}">${label}</button>`)
      .join('');
    el.querySelectorAll('[data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        period = btn.getAttribute('data-period') || '30d';
        render();
        void loadAnalytics();
      });
    });
  }

  function render() {
    renderPeriodFilters();
    renderKpis();
    renderRevenueBreakdown();
    renderTechTable();
    renderBarChart('analyticsWpChart', DATA.wpVsBookings, (r) => r.visitors);
    renderCashflowBlock();
    renderDebugMeta();
    if (!analyticsLoading && !analyticsData && !analyticsError) void loadAnalytics();
    if (!cashflowLoaded && !cashflowLoading) void loadCashflow();
  }

  global.HKPlannerAnalytics = { render };
})(window);
