(function initPlannerCatalogV1(global) {
  let catalogItems = [];
  let loaded = false;
  let loadingPromise = null;
  const modalLines = [];
  let modalDropdownOpen = false;
  let modalListenersBound = false;

  /** Boekingspagina (book.html): zelfde search/dropdown/lijnen als planner-modal. */
  const bookLines = [];
  let bookDropdownOpen = false;
  let bookListenersBound = false;

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

  function getBookElements() {
    return {
      root: document.getElementById('bookingScreen'),
      dropdown: document.getElementById('bookCatalogDropdown'),
      search: document.getElementById('bCatalogSearch'),
      results: document.getElementById('bCatalogResults'),
      lines: document.getElementById('bCatalogLines'),
      total: document.getElementById('bCatalogTotal'),
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

  function resetModal() {
    clearModalCatalogLines();
    closeModalDropdown('form_reset');
  }

  function getModalCatalogLines() {
    return modalLines.map((x) => ({ ...x }));
  }

  function setModalLines(lines) {
    modalLines.length = 0;
    const src = Array.isArray(lines) ? lines : [];
    for (const row of src) {
      const desc = String(row?.desc ?? '').trim();
      const price = Number(row?.price);
      if (!desc || !Number.isFinite(price) || price < 0) continue;
      modalLines.push({
        desc,
        price: Math.round(price * 100) / 100,
        quantity: 1,
      });
    }
    renderModalLines();
  }

  function setBookResultsOpen(isOpen) {
    const { results } = getBookElements();
    if (!results) return;
    if (isOpen) {
      results.classList.add('is-open');
      results.dataset.open = '1';
    } else {
      results.classList.remove('is-open');
      results.dataset.open = '0';
    }
  }

  function openBookDropdown(reason) {
    bookDropdownOpen = true;
    setBookResultsOpen(true);
    dropdownDebug('book_dropdown_open', { reason });
  }

  function closeBookDropdown(reason) {
    bookDropdownOpen = false;
    setBookResultsOpen(false);
    dropdownDebug('book_dropdown_close', { reason });
  }

  async function onBookingSearchInput(query) {
    await ensureLoaded();
    openBookDropdown('input');
    renderResults('bCatalogResults', search(query), (id) => `addBookingCatalogItem('${id}')`);
  }

  function renderBookingLines() {
    const { lines, total } = getBookElements();
    if (!lines) return;
    if (!bookLines.length) {
      lines.innerHTML = '<div class="catalog-v1-empty">Nog geen producten gekozen (optioneel)</div>';
      if (total) total.textContent = '€0';
      return;
    }
    let sum = 0;
    lines.innerHTML = bookLines
      .map((row, idx) => {
        sum += Number(row.price || 0);
        return `<div class="catalog-v1-line"><span>${row.desc} — €${euroDisplay(row.price)}</span><button type="button" onclick="removeBookingCatalogLine(${idx})">✕</button></div>`;
      })
      .join('');
    sum = Math.round(sum * 100) / 100;
    if (total) total.textContent = `€${euroDisplay(sum)}`;
  }

  function addBookingCatalogItem(itemId) {
    const row = getItemById(itemId);
    if (!row) return;
    if (bookLines.length >= 50) return;
    bookLines.push({ desc: row.name, price: Math.round(Number(row.price) * 100) / 100, quantity: 1 });
    renderBookingLines();
    closeBookDropdown('item_selected');
    dropdownDebug('book_item_selected', { itemId: String(itemId) });
  }

  function removeBookingCatalogLine(idx) {
    if (idx < 0 || idx >= bookLines.length) return;
    bookLines.splice(idx, 1);
    renderBookingLines();
  }

  function getBookingCatalogLines() {
    return bookLines.map((x) => ({ desc: x.desc, price: x.price, quantity: x.quantity || 1 }));
  }

  function resetBookingCatalog() {
    bookLines.length = 0;
    const { search, results } = getBookElements();
    if (search) search.value = '';
    if (results) {
      results.innerHTML = '';
      results.classList.remove('is-open');
    }
    bookDropdownOpen = false;
    renderBookingLines();
  }

  function bindBookingDropdownListeners() {
    if (bookListenersBound) return;
    const { root, dropdown, search } = getBookElements();
    if (!root || !dropdown || !search) return;
    bookListenersBound = true;

    search.addEventListener('focus', () => {
      openBookDropdown('focus');
      if (!search.value.trim()) void onBookingSearchInput('');
    });

    search.addEventListener('click', () => {
      openBookDropdown('click');
      if (!search.value.trim()) void onBookingSearchInput('');
    });

    search.addEventListener('input', () => {
      void onBookingSearchInput(search.value);
    });

    root.addEventListener('click', (e) => {
      if (!bookDropdownOpen) return;
      if (dropdown.contains(e.target)) return;
      closeBookDropdown('outside_click');
      dropdownDebug('book_outside_click', {});
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!bookDropdownOpen) return;
      const screen = document.getElementById('bookingScreen');
      if (!screen || screen.style.display === 'none') return;
      closeBookDropdown('escape');
    });
  }

  async function initBookingCatalog() {
    const { search } = getBookElements();
    if (!search) return;
    bindBookingDropdownListeners();
    await ensureLoaded();
    renderBookingLines();
  }

  global.addBookingCatalogItem = addBookingCatalogItem;
  global.removeBookingCatalogLine = removeBookingCatalogLine;

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
    resetModal,
    getModalCatalogLines,
    setModalLines,
    onAppointmentSearchInput,
    addCatalogItemToAppointment,
    closeModalDropdown,
    initBookingCatalog,
    onBookingSearchInput,
    getBookingCatalogLines,
    resetBookingCatalog,
    closeBookDropdown,
  };
})(window);
