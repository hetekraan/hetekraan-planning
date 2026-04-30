(function initPlannerPrices(global) {
  let rows = [];
  let activeCategory = 'Kranen';
  let createOverlay = null;
  let deleteOverlay = null;
  let createEscHandler = null;
  let deleteEscHandler = null;
  const CATEGORY_OPTIONS = ['Kranen', 'Quookers', 'Serviceproducten'];

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return global.HKPlannerAuthSession?.hkAuthHeader?.({ localStorageImpl: global.localStorage, documentRef: document }) || '';
  }

  async function load() {
    const res = await fetch('/api/prices', { headers: { 'X-HK-Auth': authHeader() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kon prijzen niet laden');
    rows = Array.isArray(data.items) ? data.items : [];
  }

  function toInput(v) {
    return String(v ?? '').replace(/"/g, '&quot;');
  }

  function euro(value) {
    return `€ ${Number(value || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function calculateExclFromIncl(incl, vatPct) {
    const v = Number(incl);
    const vat = Number(vatPct || 21);
    if (!Number.isFinite(v) || !Number.isFinite(vat)) return 0;
    const factor = 1 + vat / 100;
    if (factor <= 0) return 0;
    return Math.round((v / factor) * 100) / 100;
  }

  function calculateMarge(incl, inkoop) {
    const v = Number(incl);
    const i = Number(inkoop);
    if (!Number.isFinite(v) || !Number.isFinite(i)) return 0;
    return Math.round((v - i) * 100) / 100;
  }

  function calculateMargePct(incl, inkoop) {
    const v = Number(incl);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round((calculateMarge(v, inkoop) / v) * 10000) / 100;
  }

  function escapeAttr(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function escHtml(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function rowById(id) {
    return rows.find((x) => String(x.id) === String(id));
  }

  async function saveInline(id) {
    const rowEl = document.querySelector(`tr[data-price-id="${id}"]`);
    if (!rowEl) return;
    const naam = String(rowEl.querySelector('[data-f="naam"]')?.value || '').trim();
    const inkoopprijs = Number(rowEl.querySelector('[data-f="inkoopprijs"]')?.value || 0);
    const verkoopprijsInclBtw = Number(rowEl.querySelector('[data-f="verkoopprijsInclBtw"]')?.value || 0);
    const btwPct = Number(rowEl.getAttribute('data-vat-pct') || 21);
    const categorie = String(rowEl.getAttribute('data-categorie') || activeCategory);
    const sku = String(rowEl.getAttribute('data-sku') || '').trim() || null;
    if (!naam) return;
    await fetch('/api/prices', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
      body: JSON.stringify({ id, sku, naam, categorie, inkoopprijs, verkoopprijsInclBtw, btwPct }),
    });
    await render();
  }

  function bindDelete() {
    document.querySelectorAll('[data-price-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-price-delete');
        const row = rowById(id);
        if (!id || !row) return;
        openDeleteModal(row);
      });
    });
  }

  function bindInline() {
    document.querySelectorAll('[data-price-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-price-save');
        if (!id) return;
        await saveInline(id);
      });
    });
    document.querySelectorAll('tr[data-price-id]').forEach((rowEl) => {
      const inkoopInput = rowEl.querySelector('[data-f="inkoopprijs"]');
      const inclInput = rowEl.querySelector('[data-f="verkoopprijsInclBtw"]');
      const exclEl = rowEl.querySelector('[data-f="verkoopprijsExclBtw"]');
      const margeEl = rowEl.querySelector('[data-f="marge"]');
      const margePctEl = rowEl.querySelector('[data-f="margePct"]');
      const vatPct = Number(rowEl.getAttribute('data-vat-pct') || 21);
      const recalc = () => {
        const inkoop = Number(inkoopInput?.value || 0);
        const incl = Number(inclInput?.value || 0);
        const excl = calculateExclFromIncl(incl, vatPct);
        const marge = calculateMarge(incl, inkoop);
        const margePct = calculateMargePct(incl, inkoop);
        if (exclEl) exclEl.value = excl.toFixed(2);
        if (margeEl) margeEl.value = marge.toFixed(2);
        if (margePctEl) margePctEl.value = `${margePct.toFixed(2)}%`;
      };
      inkoopInput?.addEventListener('input', recalc);
      inclInput?.addEventListener('input', recalc);
      recalc();
    });
    bindDelete();
  }

  function productsForActiveCategory() {
    return rows.filter((x) => String(x.categorie || x.category || '') === activeCategory);
  }

  function renderSummary(list) {
    const el = document.getElementById('pricesSummaryBar');
    if (!el) return;
    const count = list.length;
    const avgMargePct = count
      ? Math.round((list.reduce((s, x) => s + calculateMargePct(x.verkoopprijsInclBtw, x.inkoopprijs), 0) / count) * 100) / 100
      : 0;
    const lowest = [...list].sort((a, b) => calculateMargePct(a.verkoopprijsInclBtw, a.inkoopprijs) - calculateMargePct(b.verkoopprijsInclBtw, b.inkoopprijs))[0];
    el.innerHTML = `<div class="panel-card" style="padding:10px 12px"><strong>${count}</strong> producten · Gem. marge <strong>${avgMargePct.toFixed(2)}%</strong> · Laagste marge: <strong>${escapeAttr(lowest?.naam || '-')}</strong></div>`;
  }

  function renderTable() {
    const el = document.getElementById('pricesTable');
    if (!el) return;
    const list = productsForActiveCategory();
    renderSummary(list);
    el.innerHTML = `<thead><tr><th>SKU</th><th>Naam</th><th>Inkoopprijs</th><th>Verkoopprijs incl. BTW</th><th>Verkoopprijs excl. BTW</th><th>Marge €</th><th>Marge %</th><th></th><th></th></tr></thead><tbody>${
      list
        .map(
          (r) =>
            `<tr data-price-id="${r.id}" data-sku="${escapeAttr(r.sku || '')}" data-categorie="${escapeAttr(r.categorie || '')}" data-vat-pct="${Number(r.btwPct || 21)}"><td><span style="font-size:12px;color:#7f8792;white-space:nowrap">${escapeAttr(r.sku || '-')}</span></td><td><input class="field-input" data-f="naam" value="${escapeAttr(r.naam || r.description || '')}"></td><td><div style="display:flex;align-items:center;gap:6px"><span style="color:#7f8792">€</span><input class="field-input" style="max-width:130px" type="number" step="0.01" min="0" data-f="inkoopprijs" value="${toInput(Number(r.inkoopprijs || 0).toFixed(2))}"></div></td><td><div style="display:flex;align-items:center;gap:6px"><span style="color:#7f8792">€</span><input class="field-input" style="max-width:130px" type="number" step="0.01" min="0" data-f="verkoopprijsInclBtw" value="${toInput(Number(r.verkoopprijsInclBtw || r.price || 0).toFixed(2))}"></div></td><td><input class="field-input" style="max-width:130px" data-f="verkoopprijsExclBtw" value="${toInput(Number(r.verkoopprijsExclBtw || 0).toFixed(2))}" readonly tabindex="-1"></td><td><input class="field-input" style="max-width:120px" data-f="marge" value="${toInput(Number(r.marge || 0).toFixed(2))}" readonly tabindex="-1"></td><td><input class="field-input" style="max-width:100px" data-f="margePct" value="${toInput(`${calculateMargePct(r.verkoopprijsInclBtw, r.inkoopprijs).toFixed(2)}%`)}" readonly tabindex="-1"></td><td><button class="today-btn today-btn--ghost" data-price-save="${r.id}">Opslaan</button></td><td><button class="today-btn today-btn--ghost" data-price-delete="${r.id}">Verwijderen</button></td></tr>`
        )
        .join('')
    }</tbody>`;
    bindInline();
  }

  function removeCreateModal() {
    if (createOverlay?.parentNode) createOverlay.parentNode.removeChild(createOverlay);
    createOverlay = null;
    if (createEscHandler) document.removeEventListener('keydown', createEscHandler);
    createEscHandler = null;
  }

  function removeDeleteModal() {
    if (deleteOverlay?.parentNode) deleteOverlay.parentNode.removeChild(deleteOverlay);
    deleteOverlay = null;
    if (deleteEscHandler) document.removeEventListener('keydown', deleteEscHandler);
    deleteEscHandler = null;
  }

  function validateCreateForm(fields, errEl, saveBtn) {
    const naam = String(fields.naam.value || '').trim();
    const category = String(fields.category.value || '').trim();
    const inkoopprijs = Number(fields.inkoopprijs.value);
    const verkoopprijsInclBtw = Number(fields.verkoopprijsInclBtw.value);
    const errs = [];
    if (!naam) errs.push('Naam is verplicht.');
    if (!category) errs.push('Categorie is verplicht.');
    if (!Number.isFinite(inkoopprijs) || inkoopprijs < 0) errs.push('Inkoopprijs moet een geldig getal zijn.');
    if (!Number.isFinite(verkoopprijsInclBtw) || verkoopprijsInclBtw < 0) errs.push('Verkoopprijs incl. BTW moet een geldig getal zijn.');
    errEl.textContent = errs[0] || '';
    saveBtn.disabled = errs.length > 0;
    saveBtn.style.opacity = saveBtn.disabled ? '0.55' : '1';
    return errs.length === 0;
  }

  function openCreateModal() {
    removeCreateModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px" role="dialog" aria-modal="true" aria-labelledby="pricesCreateTitle">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div class="modal-title" id="pricesCreateTitle" style="margin:0">Nieuw product toevoegen</div>
          <button type="button" class="btn-cancel" data-close-create-modal>✕</button>
        </div>
        <div class="form-row">
          <label class="form-label">Naam</label>
          <input class="form-input" type="text" id="pricesCreateNaam">
        </div>
        <div class="form-row">
          <label class="form-label">SKU (optioneel)</label>
          <input class="form-input" type="text" id="pricesCreateSku">
        </div>
        <div class="form-row">
          <label class="form-label">Categorie</label>
          <select class="form-select" id="pricesCreateCategory">${CATEGORY_OPTIONS.map((x) => `<option value="${x}" ${x === activeCategory ? 'selected' : ''}>${x}</option>`).join('')}</select>
        </div>
        <div class="form-row-2">
          <div>
            <label class="form-label">Inkoopprijs</label>
            <input class="form-input" type="number" step="0.01" min="0" id="pricesCreateInkoopprijs">
          </div>
          <div>
            <label class="form-label">Verkoopprijs incl. BTW</label>
            <input class="form-input" type="number" step="0.01" min="0" id="pricesCreateVerkoopprijsInclBtw">
          </div>
        </div>
        <div class="form-hint-subtle is-error" id="pricesCreateError"></div>
        <div class="modal-actions">
          <button type="button" class="btn-cancel" data-close-create-modal>Annuleren</button>
          <button type="button" class="btn-save" id="pricesCreateSaveBtn" disabled>Opslaan</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    createOverlay = overlay;
    const fields = {
      naam: overlay.querySelector('#pricesCreateNaam'),
      sku: overlay.querySelector('#pricesCreateSku'),
      category: overlay.querySelector('#pricesCreateCategory'),
      inkoopprijs: overlay.querySelector('#pricesCreateInkoopprijs'),
      verkoopprijsInclBtw: overlay.querySelector('#pricesCreateVerkoopprijsInclBtw'),
    };
    const errEl = overlay.querySelector('#pricesCreateError');
    const saveBtn = overlay.querySelector('#pricesCreateSaveBtn');
    const close = () => removeCreateModal();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll('[data-close-create-modal]').forEach((btn) => btn.addEventListener('click', close));
    const onInput = () => validateCreateForm(fields, errEl, saveBtn);
    Object.values(fields).forEach((el) => el?.addEventListener('input', onInput));
    createEscHandler = (e) => {
      if (e.key === 'Escape' && createOverlay) close();
    };
    document.addEventListener('keydown', createEscHandler);
    saveBtn.addEventListener('click', async () => {
      if (!validateCreateForm(fields, errEl, saveBtn)) return;
      await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
        body: JSON.stringify({
          naam: String(fields.naam.value || '').trim(),
          sku: String(fields.sku.value || '').trim() || null,
          categorie: String(fields.category.value || '').trim(),
          inkoopprijs: Number(fields.inkoopprijs.value),
          verkoopprijsInclBtw: Number(fields.verkoopprijsInclBtw.value),
          btwPct: 21,
        }),
      });
      close();
      await render();
    });
    validateCreateForm(fields, errEl, saveBtn);
    fields.naam?.focus();
  }

  function openDeleteModal(row) {
    removeDeleteModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="modal" style="max-width:460px" role="dialog" aria-modal="true" aria-labelledby="pricesDeleteTitle">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div class="modal-title" id="pricesDeleteTitle" style="margin:0">Product verwijderen</div>
          <button type="button" class="btn-cancel" data-close-delete-modal>✕</button>
        </div>
        <div class="form-row">
          <div class="form-label" style="text-transform:none;font-size:14px;font-weight:500">Weet je zeker dat je <strong>${escHtml(row.naam || row.description)}</strong> wilt verwijderen?</div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-cancel" data-close-delete-modal>Annuleren</button>
          <button type="button" class="btn-save" id="pricesDeleteConfirmBtn">Verwijderen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    deleteOverlay = overlay;
    const close = () => removeDeleteModal();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll('[data-close-delete-modal]').forEach((btn) => btn.addEventListener('click', close));
    deleteEscHandler = (e) => {
      if (e.key === 'Escape' && deleteOverlay) close();
    };
    document.addEventListener('keydown', deleteEscHandler);
    overlay.querySelector('#pricesDeleteConfirmBtn')?.addEventListener('click', async () => {
      await fetch(`/api/prices?id=${encodeURIComponent(String(row.id || ''))}`, {
        method: 'DELETE',
        headers: { 'X-HK-Auth': authHeader() },
      });
      close();
      await render();
    });
    overlay.querySelector('#pricesDeleteConfirmBtn')?.focus();
  }

  async function render() {
    try {
      await load();
      if (!CATEGORY_OPTIONS.includes(activeCategory)) activeCategory = 'Kranen';
      renderTable();
    } catch (err) {
      const el = document.getElementById('pricesTable');
      if (el) el.innerHTML = `<tbody><tr><td>${String(err.message || err)}</td></tr></tbody>`;
    }
  }

  function setCategory(nextCategory) {
    const next = String(nextCategory || '').trim();
    if (!CATEGORY_OPTIONS.includes(next)) return;
    activeCategory = next;
    render();
  }

  global.HKPlannerPrices = { render, openCreateModal, setCategory };
})(window);
