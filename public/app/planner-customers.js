(function initPlannerCustomers(global) {
  let searchSeq = 0;
  let detailSeq = 0;
  let debounceTimer = null;
  let bound = false;
  let currentDetailCustomer = null;
  let lastResults = [];

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

  function cardHtml(c, idx) {
    const contactBits = [];
    if (c.phone) contactBits.push(`<span>${escHtml(c.phone)}</span>`);
    if (c.email) contactBits.push(`<span>${escHtml(c.email)}</span>`);
    if (c.hasMoneybird) contactBits.push('<span class="hk-customer-card-mb">MB</span>');
    const cid = c.contactId ? escHtml(c.contactId) : '';
    return `<button type="button" class="hk-customer-card" data-action="open-customer" data-contact-id="${cid}" data-idx="${idx}">
      <div class="hk-customer-card-name">${escHtml(c.name || 'Onbekend')}</div>
      <div class="hk-customer-card-address">${escHtml(cleanAddress(c.address) || '—')}</div>
      <div class="hk-customer-card-contact">${contactBits.join('') || '<span>—</span>'}</div>
      ${lastApptHtml(c.lastAppointment)}
    </button>`;
  }

  function renderResults(list) {
    const el = resultsEl();
    if (!el) return;
    lastResults = Array.isArray(list) ? list : [];
    if (!lastResults.length) {
      renderStatus('Geen klanten gevonden.');
      return;
    }
    el.innerHTML = lastResults.map((c, i) => cardHtml(c, i)).join('');
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

  function actionsHtml(a) {
    if (!a.date) return '';
    const date = escHtml(a.date);
    const toPlanning = `<button type="button" class="hk-btn hk-appt-action-btn" data-action="appt-to-planning" data-date="${date}">Naar planning</button>`;
    const edit =
      a.source === 'planned' && a.contactId
        ? `<button type="button" class="hk-btn hk-btn-primary hk-appt-action-btn" data-action="appt-edit" data-contact-id="${escHtml(
            a.contactId
          )}" data-date="${date}">Bewerken</button>`
        : '';
    return `${toPlanning}${edit}`;
  }

  function apptHtml(a, idx) {
    const meta = statusMeta(a);
    const srcCls =
      a.source === 'legacy'
        ? 'hk-appt--legacy'
        : a.source === 'planned'
          ? 'hk-appt--planned'
          : 'hk-appt--snapshot';
    const tag = a.source === 'legacy' ? '<span class="hk-customer-card-legacy-tag">legacy</span>' : '';
    const typePart = a.type ? escHtml(a.type) : '—';
    const isProv = a.isProvisionalPrice === true;
    const totalCls = isProv ? 'hk-appt-total hk-appt-total--provisional' : 'hk-appt-total';
    const totalAttr = isProv ? ' title="Voorlopige prijs"' : '';
    const total =
      a.totalPrice != null ? `<span class="${totalCls}"${totalAttr}>${escHtml(euro(a.totalPrice))}</span>` : '';
    const bodyId = `hk-appt-body-${idx}`;
    const descHtml = a.desc ? `<p class="hk-appt-desc">${escHtml(a.desc)}</p>` : '';
    const provNote = isProv
      ? '<p class="hk-appt-provisional-note">Voorlopige prijs — definitief na afronden.</p>'
      : '';
    const bodyCls = isProv ? 'hk-appt-body hk-appt-body--provisional' : 'hk-appt-body';
    return `<div class="hk-appt ${srcCls}">
      <button type="button" class="hk-appt-head" data-action="toggle-appt" aria-expanded="false" aria-controls="${bodyId}">
        <span class="hk-appt-status" title="${meta.label}" aria-label="${meta.label}">${meta.icon}</span>
        <span class="hk-appt-date">${escHtml(formatNlDate(a.date))}</span>
        <span class="hk-appt-type">${typePart}</span>${tag}
        ${total}
        <span class="hk-appt-caret" aria-hidden="true">▾</span>
      </button>
      <div class="${bodyCls}" id="${bodyId}" role="region">
        <div class="hk-appt-body-inner">
          ${descHtml || '<p class="hk-appt-desc hk-appt-desc--empty">Geen omschrijving</p>'}
          ${priceLinesHtml(a.priceLines)}
          ${provNote}
          <div class="hk-appt-actions">${actionsHtml(a)}</div>
        </div>
      </div>
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
      ? appts.map((a, i) => apptHtml(a, i)).join('')
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

  function moneybirdOnlyHtml() {
    return (
      '<p class="hk-customers-status">Deze klant staat alleen in Moneybird ' +
      '(nog geen GHL-koppeling). Maak een nieuwe afspraak om de koppeling te leggen.</p>' +
      '<button type="button" class="hk-detail-new-appt" data-action="customer-new-appointment">+ Nieuwe afspraak</button>'
    );
  }

  async function openDetail(contactId, cardData) {
    const aside = document.getElementById('customerDetail');
    const body = document.getElementById('customerDetailBody');
    if (aside) {
      aside.classList.add('is-open');
      aside.setAttribute('aria-hidden', 'false');
    }
    if (!body) return;
    if (!contactId) {
      // Moneybird-only klant zonder GHL-koppeling: nette melding + booking-knop
      // (createAppointment maakt/koppelt het GHL-contact via de bestaande flow).
      if (cardData && cardData.hasMoneybird) {
        currentDetailCustomer = {
          contactId: '',
          name: cardData.name || '',
          address: cleanAddress(cardData.address),
          phone: cardData.phone || '',
          email: cardData.email || '',
        };
        body.innerHTML = moneybirdOnlyHtml();
        return;
      }
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

  function notify(msg) {
    if (typeof global.showToast === 'function') global.showToast(msg, 'info');
    else global.alert?.(msg);
  }

  function goToPlanning(date) {
    if (typeof global.switchSidebarView !== 'function' || typeof global.goToDateStr !== 'function') {
      console.warn('[planner-customers] planner-navigatie niet beschikbaar');
      notify('Planner niet beschikbaar');
      return;
    }
    closeDetail();
    global.switchSidebarView('today', null);
    global.goToDateStr(date);
  }

  async function editPlannedAppt(contactId, date) {
    if (
      typeof global.switchSidebarView !== 'function' ||
      typeof global.goToDateStr !== 'function' ||
      typeof global.openAppointmentEditModal !== 'function'
    ) {
      console.warn('[planner-customers] planner-bewerken niet beschikbaar');
      notify('Planner niet beschikbaar');
      return;
    }
    if (!contactId || !date) return;
    closeDetail();
    global.switchSidebarView('today', null);
    await global.goToDateStr(date);
    global.openAppointmentEditModal(`hk-b1:${contactId}:${date}`);
  }

  function toggleAppt(btn) {
    const aside = document.getElementById('customerDetail');
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    const willOpen = btn.getAttribute('aria-expanded') !== 'true';
    // Accordion: sluit alle andere open panels.
    aside?.querySelectorAll('[data-action="toggle-appt"][aria-expanded="true"]').forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
      const bd = document.getElementById(b.getAttribute('aria-controls'));
      if (bd) bd.classList.remove('is-open');
    });
    if (willOpen && body) {
      btn.setAttribute('aria-expanded', 'true');
      body.classList.add('is-open');
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
      const idx = Number(openBtn.getAttribute('data-idx'));
      const cardData = Number.isInteger(idx) ? lastResults[idx] : null;
      openDetail(openBtn.getAttribute('data-contact-id') || '', cardData);
    }
  }

  function onDetailClick(e) {
    if (e.target.closest('[data-action="customer-detail-close"]')) {
      closeDetail();
      return;
    }
    const toggleBtn = e.target.closest('[data-action="toggle-appt"]');
    if (toggleBtn) {
      toggleAppt(toggleBtn);
      return;
    }
    const toPlanningBtn = e.target.closest('[data-action="appt-to-planning"]');
    if (toPlanningBtn) {
      goToPlanning(toPlanningBtn.getAttribute('data-date') || '');
      return;
    }
    const editBtn = e.target.closest('[data-action="appt-edit"]');
    if (editBtn) {
      void editPlannedAppt(
        editBtn.getAttribute('data-contact-id') || '',
        editBtn.getAttribute('data-date') || ''
      );
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
