(function initPlannerCatalogV1(global) {
  let catalogItems = [];
  let loaded = false;
  let loadingPromise = null;
  const modalLines = [];
  let modalDropdownOpen = false;
  let modalListenersBound = false;

  function isDropdownDebugEnabled() {
    try {
      return localStorage.getItem('hk_debug_catalog_dropdown') === '1';
    } catch (_) {
      return false;
    }
  }

  function dropdownDebug(step, payload) {
    if (!isDropdownDebugEnabled()) return;
    try {
      console.debug(`[CATALOG_DROPDOWN] ${step}`, payload || {});
    } catch (_) {}
  }

  function euroDisplay(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    return v.toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function normalizeQuery(q) {
    return String(q || '').trim().toLowerCase();
  }

  async function ensureLoaded() {
    if (loaded) return catalogItems;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      const res = await fetch('/data/catalog-v1.json', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const items = Array.isArray(data?.items) ? data.items : [];
      catalogItems = items.filter((x) => x && x.active !== false && x.name && Number.isFinite(Number(x.price)));
      loaded = true;
      return catalogItems;
    })();
    return loadingPromise;
  }

  function search(query, opts = {}) {
    const q = normalizeQuery(query);
    const limit = Number(opts.limit || 15);
    const category = normalizeQuery(opts.category || '');
    let list = catalogItems;
    if (category) list = list.filter((x) => normalizeQuery(x.category) === category);
    if (!q) return list.slice(0, limit);
    return list
      .filter((x) => {
        const hay = normalizeQuery(x.searchText || `${x.name} ${x.category}`);
        return hay.includes(q);
      })
      .slice(0, limit);
  }

  function renderResults(containerId, rows, makeOnClick) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.classList.add('is-open');
    if (!rows.length) {
      container.innerHTML = '<div class="catalog-v1-empty">Geen resultaten</div>';
      return;
    }
    container.innerHTML = rows
      .map(
        (row) =>
          `<button type="button" class="catalog-v1-result" onclick="${makeOnClick(String(row.id).replace(/'/g, "\\'"))}"><span>${row.name}</span><span>€${euroDisplay(row.price)}</span></button>`
      )
      .join('');
  }

  function getModalElements() {
    return {
      overlay: document.getElementById('modalOverlay'),
      section: document.getElementById('mCatalogSection'),
      dropdown: document.getElementById('mCatalogDropdown'),
      search: document.getElementById('mCatalogSearch'),
      results: document.getElementById('mCatalogResults'),
    };
  }

  function setModalResultsOpen(isOpen) {
    const { results } = getModalElements();
    if (!results) return;
    if (isOpen) {
      results.classList.add('is-open');
      results.dataset.open = '1';
    } else {
      results.classList.remove('is-open');
      results.dataset.open = '0';
    }
  }

  function openModalDropdown(reason) {
    const { section } = getModalElements();
    if (section && !section.open) section.open = true;
    modalDropdownOpen = true;
    setModalResultsOpen(true);
    dropdownDebug('dropdown_open', { reason });
  }

  function closeModalDropdown(reason) {
    modalDropdownOpen = false;
    setModalResultsOpen(false);
    dropdownDebug('dropdown_close', { reason });
  }

  async function onModalSearchInput(query) {
    await ensureLoaded();
    openModalDropdown('input');
    renderResults('mCatalogResults', search(query), (id) => `addModalCatalogItem('${id}')`);
  }

  function getItemById(itemId) {
    return catalogItems.find((x) => String(x.id) === String(itemId));
  }

  function removeModalLine(idx) {
    if (idx < 0 || idx >= modalLines.length) return;
    modalLines.splice(idx, 1);
    renderModalLines();
  }

  function renderModalLines() {
    const el = document.getElementById('mCatalogLines');
    if (!el) return;
    if (!modalLines.length) {
      el.innerHTML = '<div class="catalog-v1-empty">Nog geen prijsregels gekozen</div>';
      if (global.HKPlannerManualAppointment?.updatePricePreview) {
        global.HKPlannerManualAppointment.updatePricePreview();
      }
      return;
    }
    let total = 0;
    el.innerHTML = modalLines
      .map((row, idx) => {
        total += Number(row.price || 0);
        return `<div class="catalog-v1-line"><span>${row.desc} — €${euroDisplay(row.price)}</span><button type="button" onclick="removeModalCatalogLine(${idx})">✕</button></div>`;
      })
      .join('');
    total = Math.round(total * 100) / 100;
    if (global.HKPlannerManualAppointment?.updatePricePreview) {
      global.HKPlannerManualAppointment.updatePricePreview();
    }
  }

  function addModalCatalogItem(itemId) {
    const row = getItemById(itemId);
    if (!row) return;
    modalLines.push({ desc: row.name, price: Math.round(Number(row.price) * 100) / 100, quantity: 1 });
    renderModalLines();
    closeModalDropdown('item_selected');
    dropdownDebug('item_selected', { itemId: String(itemId) });
  }

  function clearModalCatalogLines() {
    modalLines.length = 0;
    const search = document.getElementById('mCatalogSearch');
    if (search) search.value = '';
    const results = document.getElementById('mCatalogResults');
    if (results) results.innerHTML = '';
    closeModalDropdown('clear');
    renderModalLines();
  }

  function getModalCatalogLines() {
    return modalLines.map((x) => ({ ...x }));
  }

  async function onAppointmentSearchInput(appointmentId, query) {
    await ensureLoaded();
    const sid = global.appointmentDomSafeId ? global.appointmentDomSafeId(appointmentId) : String(appointmentId);
    const apptIdEscaped = String(appointmentId).replace(/'/g, "\\'");
    renderResults(
      `catalog-results-${sid}`,
      search(query),
      (id) => `addCatalogItemToAppointment('${apptIdEscaped}','${id}')`
    );
  }

  function addCatalogItemToAppointment(appointmentId, itemId) {
    const row = getItemById(itemId);
    if (!row) return;
    if (typeof global.addExtraFromCatalog === 'function') {
      global.addExtraFromCatalog(appointmentId, {
        desc: row.name,
        price: Math.round(Number(row.price) * 100) / 100,
      });
    }
  }

  async function init() {
    await ensureLoaded();
    renderModalLines();
    bindModalDropdownListeners();
  }

  function bindModalDropdownListeners() {
    if (modalListenersBound) return;
    const { overlay, section, dropdown, search } = getModalElements();
    if (!overlay || !dropdown || !search) return;
    modalListenersBound = true;

    search.addEventListener('focus', () => {
      openModalDropdown('focus');
      if (!search.value.trim()) void onModalSearchInput('');
    });

    search.addEventListener('click', () => {
      openModalDropdown('click');
      if (!search.value.trim()) void onModalSearchInput('');
    });

    overlay.addEventListener('click', (e) => {
      if (!modalDropdownOpen) return;
      if (!overlay.classList.contains('visible')) return;
      if (dropdown.contains(e.target)) return;
      closeModalDropdown('outside_click');
      dropdownDebug('outside_click', {});
    });

    overlay.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('visible')) return;
      if (e.key !== 'Escape') return;
      if (!modalDropdownOpen) return;
      closeModalDropdown('escape');
    });

    if (section) {
      section.addEventListener('toggle', () => {
        dropdownDebug('toggle_collapsed', { open: !!section.open });
        if (!section.open) closeModalDropdown('section_collapsed');
      });
    }
  }

  global.HKPlannerCatalogV1 = {
    init,
    ensureLoaded,
    search,
    onModalSearchInput,
    addModalCatalogItem,
    removeModalLine,
    clearModalCatalogLines,
    getModalCatalogLines,
    onAppointmentSearchInput,
    addCatalogItemToAppointment,
    closeModalDropdown,
  };
})(window);
