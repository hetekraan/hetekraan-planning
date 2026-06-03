(function initPlannerCustomers(global) {
  let searchSeq = 0;
  let detailSeq = 0;
  let debounceTimer = null;
  let bound = false;
  let currentDetailCustomer = null;

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

  function cleanAddress(addr) {
    const s = String(addr || '').replace(/\s+/g, ' ').trim();
    const pc = s.match(/\d{4}\s?[A-Za-z]{2}/);
    if (!pc) return s;
    const idx = s.indexOf(pc[0]);
    const street = s.slice(0, idx).replace(/[,\s]+$/, '').trim();
    const after = s.slice(idx + pc[0].length).replace(/^[,\s]+/, '');
    const city = after.split(/,|\s\d{4}\s?[A-Za-z]{2}/)[0].trim();
    const pcNorm = pc[0].toUpperCase().replace(/(\d{4})\s?([A-Za-z]{2})/, '$1 $2');
    return [street, pcNorm, city].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function formatNlDate(ymd) {
    const s = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return dt.toLocaleDateString('nl-NL', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  function resultsEl() {
    return document.getElementById('customersResults');
  }

  function renderStatus(msg, kind) {
    const el = resultsEl();
    if (!el) return;
    const cls = kind === 'error' ? 'hk-customers-status hk-customers-status--error' : 'hk-customers-status';
    el.innerHTML = `<p class="${cls}">${escHtml(msg)}</p>`;
  }

  function lastApptHtml(last) {
    if (!last || !last.date) {
      return '<div class="hk-customer-card-last hk-customer-card-last--none">Geen afspraken (nieuw)</div>';
    }
    const typePart = last.type ? ` (${escHtml(last.type)})` : '';
    const isLegacy = last.source === 'legacy';
    const legacyTag = isLegacy ? '<span class="hk-customer-card-legacy-tag">legacy</span>' : '';
    const cls = isLegacy
      ? 'hk-customer-card-last hk-customer-card-last--legacy'
      : 'hk-customer-card-last';
    return `<div class="${cls}">Laatste afspraak: ${escHtml(formatNlDate(last.date))}${typePart}${legacyTag}</div>`;
  }

  function cardHtml(c) {
    const contactBits = [];
    if (c.phone) contactBits.push(`<span>${escHtml(c.phone)}</span>`);
    if (c.email) contactBits.push(`<span>${escHtml(c.email)}</span>`);
    if (c.hasMoneybird) contactBits.push('<span class="hk-customer-card-mb">MB</span>');
    const cid = c.contactId ? escHtml(c.contactId) : '';
    return `<button type="button" class="hk-customer-card" data-action="open-customer" data-contact-id="${cid}">
      <div class="hk-customer-card-name">${escHtml(c.name || 'Onbekend')}</div>
      <div class="hk-customer-card-address">${escHtml(cleanAddress(c.address) || '—')}</div>
      <div class="hk-customer-card-contact">${contactBits.join('') || '<span>—</span>'}</div>
      ${lastApptHtml(c.lastAppointment)}
    </button>`;
  }

  function renderResults(list) {
    const el = resultsEl();
    if (!el) return;
    if (!Array.isArray(list) || !list.length) {
      renderStatus('Geen klanten gevonden.');
      return;
    }
    el.innerHTML = list.map(cardHtml).join('');
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    renderStatus('Zoeken…');
    try {
      const res = await fetch(`/api/customer-search?q=${encodeURIComponent(q)}`, {
        cache: 'no-store',
        headers: { 'X-HK-Auth': authHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== searchSeq) return;
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Zoeken mislukt (${res.status})`);
      }
      renderResults(Array.isArray(data?.results) ? data.results : []);
    } catch (err) {
      if (seq !== searchSeq) return;
      renderStatus(String(err?.message || err), 'error');
    }
  }

  function onInput() {
    const raw = String(document.getElementById('customersSearch')?.value || '').trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (raw.length < 2) {
      searchSeq += 1; // annuleer eventuele inflight render
      renderStatus(raw.length === 0 ? 'Begin met typen om klanten te zoeken.' : 'Typ minimaal 2 tekens…');
      return;
    }
    debounceTimer = setTimeout(() => runSearch(raw), 300);
  }

  function euro(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(n));
  }

  function statusMeta(appt) {
    if (appt.source === 'planned' || appt.status === 'gepland') return { icon: '📅', label: 'Gepland' };
    return { icon: '✅', label: 'Klaar' };
  }

  function priceLinesHtml(lines) {
    if (!Array.isArray(lines) || !lines.length) return '';
    const items = lines
      .map((l) => `<li><span>${escHtml(l.desc)}</span><span>${escHtml(euro(l.price))}</span></li>`)
      .join('');
    return `<ul class="hk-appt-lines">${items}</ul>`;
  }

  function apptHtml(a) {
    const meta = statusMeta(a);
    const srcCls =
      a.source === 'legacy'
        ? 'hk-appt--legacy'
        : a.source === 'planned'
          ? 'hk-appt--planned'
          : 'hk-appt--snapshot';
    const tag = a.source === 'legacy' ? '<span class="hk-customer-card-legacy-tag">legacy</span>' : '';
    const typePart = a.type ? escHtml(a.type) : '—';
    const total = a.totalPrice != null ? `<span class="hk-appt-total">${escHtml(euro(a.totalPrice))}</span>` : '';
    return `<div class="hk-appt ${srcCls}">
      <div class="hk-appt-head">
        <span class="hk-appt-status" title="${meta.label}" aria-label="${meta.label}">${meta.icon}</span>
        <span class="hk-appt-date">${escHtml(formatNlDate(a.date))}</span>
        <span class="hk-appt-type">${typePart}</span>${tag}
        ${total}
      </div>
      ${priceLinesHtml(a.priceLines)}
    </div>`;
  }

  function detailHtml(data) {
    const c = data.contact || {};
    const appts = Array.isArray(data.appointments) ? data.appointments : [];
    const cityLine = [c.postalCode, c.city].filter(Boolean).join(' ');
    const infoRows = [];
    if (c.address) infoRows.push(`<div class="hk-detail-line">${escHtml(c.address)}</div>`);
    if (cityLine) infoRows.push(`<div class="hk-detail-line">${escHtml(cityLine)}</div>`);
    if (c.phone) infoRows.push(`<div class="hk-detail-line">${escHtml(c.phone)}</div>`);
    if (c.email) infoRows.push(`<div class="hk-detail-line">${escHtml(c.email)}</div>`);
    const apptsHtml = appts.length
      ? appts.map(apptHtml).join('')
      : '<p class="hk-customers-status">Nog geen afspraken bekend.</p>';
    return `
      <div class="hk-detail-section">
        <div class="hk-detail-name">${escHtml(c.name || 'Onbekende klant')}</div>
        ${infoRows.join('')}
      </div>
      <button type="button" class="hk-detail-new-appt" data-action="customer-new-appointment">+ Nieuwe afspraak</button>
      <div class="hk-detail-section">
        <div class="hk-detail-section-title">Afspraken</div>
        ${apptsHtml}
      </div>`;
  }

  async function openDetail(contactId) {
    const aside = document.getElementById('customerDetail');
    const body = document.getElementById('customerDetailBody');
    if (aside) {
      aside.classList.add('is-open');
      aside.setAttribute('aria-hidden', 'false');
    }
    if (!body) return;
    if (!contactId) {
      currentDetailCustomer = null;
      body.innerHTML =
        '<p class="hk-customers-status hk-customers-status--error">Geen GHL-contact gekoppeld aan deze klant.</p>';
      return;
    }
    const seq = ++detailSeq;
    body.innerHTML = '<p class="hk-customers-status">Klantgegevens laden…</p>';
    try {
      const res = await fetch(`/api/customer-detail?contactId=${encodeURIComponent(contactId)}`, {
        cache: 'no-store',
        headers: { 'X-HK-Auth': authHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== detailSeq) return;
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Detail laden mislukt (${res.status})`);
      }
      const c = data.contact || {};
      currentDetailCustomer = {
        contactId,
        name: c.name || '',
        address: cleanAddress(c.address),
        phone: c.phone || '',
        email: c.email || '',
      };
      body.innerHTML = detailHtml(data);
    } catch (err) {
      if (seq !== detailSeq) return;
      currentDetailCustomer = null;
      body.innerHTML = `<p class="hk-customers-status hk-customers-status--error">${escHtml(
        String(err?.message || err)
      )}</p>`;
    }
  }

  function closeDetail() {
    const aside = document.getElementById('customerDetail');
    if (aside) {
      aside.classList.remove('is-open');
      aside.setAttribute('aria-hidden', 'true');
    }
  }

  function onResultsClick(e) {
    const openBtn = e.target.closest('[data-action="open-customer"]');
    if (openBtn) {
      openDetail(openBtn.getAttribute('data-contact-id') || '');
    }
  }

  function onDetailClick(e) {
    if (e.target.closest('[data-action="customer-detail-close"]')) {
      closeDetail();
      return;
    }
    if (e.target.closest('[data-action="customer-new-appointment"]')) {
      if (currentDetailCustomer && global.HKPlannerManualAppointment?.openForCustomer) {
        global.HKPlannerManualAppointment.openForCustomer(currentDetailCustomer);
      }
    }
  }

  function bind() {
    if (bound) return;
    const input = document.getElementById('customersSearch');
    const results = document.getElementById('customersResults');
    const aside = document.getElementById('customerDetail');
    if (!input || !results) return;
    input.addEventListener('input', onInput);
    results.addEventListener('click', onResultsClick);
    aside?.addEventListener('click', onDetailClick);
    global.addEventListener('hk:customer-appointment-created', (e) => {
      const cid = e?.detail?.contactId;
      const detailAside = document.getElementById('customerDetail');
      if (
        cid &&
        detailAside?.classList.contains('is-open') &&
        currentDetailCustomer?.contactId === cid
      ) {
        void openDetail(cid);
      }
    });
    bound = true;
  }

  function render() {
    bind();
    const el = resultsEl();
    if (el && !el.dataset.hkInit) {
      el.dataset.hkInit = '1';
      renderStatus('Begin met typen om klanten te zoeken.');
    }
  }

  global.HKPlannerCustomers = { render, openDetail, closeDetail };
})(window);
