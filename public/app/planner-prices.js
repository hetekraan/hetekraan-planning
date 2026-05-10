(function initPlannerPrices(global) {
  let rows = [];
  let draftRows = [];
  let isEditingProducts = false;
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

  function vatFactorFromPct(vatPct) {
    const vat = Number(vatPct || 21);
    if (!Number.isFinite(vat)) return 1.21;
    return 1 + vat / 100;
  }

  function inclToExcl(incl, vatPct) {
    const v = Number(incl);
    const factor = vatFactorFromPct(vatPct);
    if (!Number.isFinite(v) || factor <= 0) return 0;
    return v / factor;
  }

  function exclToIncl(excl, vatPct) {
    const v = Number(excl);
    const factor = vatFactorFromPct(vatPct);
    if (!Number.isFinite(v) || factor <= 0) return 0;
    return v * factor;
  }

  function computeMargins({ verkoopExcl, inkoop }) {
    const verkoop = Number(verkoopExcl);
    const cost = Number(inkoop);
    const safeVerkoop = Number.isFinite(verkoop) ? verkoop : 0;
    const safeCost = Number.isFinite(cost) ? cost : 0;
    const margeEuro = safeVerkoop - safeCost;
    const margePct = safeVerkoop === 0 ? 0 : (margeEuro / safeVerkoop) * 100;
    return { margeEuro, margePct };
  }

  function round2(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  function clamp(value, min, max) {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : 0;
    return Math.min(Math.max(safe, min), max);
  }

  function deriveVerkoopExcl(row = {}) {
    const incl = Number(row.verkoopprijsInclBtw ?? row.price ?? 0);
    const vatPct = Number(row.btwPct || 21);
    return inclToExcl(incl, vatPct);
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
    const source = isEditingProducts ? draftRows : rows;
    return source.find((x) => String(x.id) === String(id));
  }

  function syncEditButtons() {
    const toggleBtn = document.getElementById('productsEditToggleBtn');
    const cancelBtn = document.getElementById('productsEditCancelBtn');
    if (toggleBtn) toggleBtn.textContent = isEditingProducts ? 'Opslaan' : 'Bewerk';
    if (cancelBtn) cancelBtn.style.display = isEditingProducts ? '' : 'none';
  }

  function cloneRowsForDraft() {
    draftRows = rows.map((r) => ({ ...r }));
  }

  async function saveEditedRows() {
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const changed = draftRows.filter((r) => {
      const base = byId.get(String(r.id));
      if (!base) return false;
      const baseNaam = String(base.naam || base.description || '').trim();
      const baseInkoop = round2(Number(base.inkoopprijs || 0));
      const baseIncl = round2(Number(base.verkoopprijsInclBtw ?? base.price ?? 0));
      const nextNaam = String(r.naam || r.description || '').trim();
      const nextInkoop = round2(Number(r.inkoopprijs || 0));
      const nextIncl = round2(Number(r.verkoopprijsInclBtw ?? r.price ?? 0));
      return baseNaam !== nextNaam || baseInkoop !== nextInkoop || baseIncl !== nextIncl;
    });
    for (const r of changed) {
      const id = String(r.id || '');
      const naam = String(r.naam || r.description || '').trim();
      if (!id || !naam) continue;
      await fetch('/api/prices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
        body: JSON.stringify({
          id,
          sku: String(r.sku || '').trim() || null,
          naam,
          categorie: String(r.categorie || activeCategory),
          inkoopprijs: Number(r.inkoopprijs || 0),
          verkoopprijsInclBtw: Number(r.verkoopprijsInclBtw ?? r.price ?? 0),
          btwPct: Number(r.btwPct || 21),
        }),
      });
    }
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
    if (!isEditingProducts) return;
    document.querySelectorAll('tr[data-price-id]').forEach((rowEl) => {
      const inkoopInput = rowEl.querySelector('[data-f="inkoopprijs"]');
      const inclInput = rowEl.querySelector('[data-f="verkoopprijsInclBtw"]');
      const exclEl = rowEl.querySelector('[data-f="verkoopprijsExclBtw"]');
      const margeEl = rowEl.querySelector('[data-f="marge"]');
      const margePctEl = rowEl.querySelector('[data-f="margePct"]');
      const vatPct = Number(rowEl.getAttribute('data-vat-pct') || 21);
      const recalcFrom = (source) => {
        const inkoop = Number(inkoopInput?.value || 0);
        const incl = Number(inclInput?.value || 0);
        const excl = Number(exclEl?.value || 0);
        const margeEuro = Number(margeEl?.value || 0);
        const rawPct = String(margePctEl?.value || '').replace('%', '').trim();
        const margePct = Number(rawPct || 0);
        let nextInkoop = Number.isFinite(inkoop) ? inkoop : 0;
        let nextIncl = Number.isFinite(incl) ? incl : 0;
        let nextExcl = Number.isFinite(excl) ? excl : 0;

        // Canonical: all margin calculations use verkoopExcl.
        if (source === 'incl') {
          nextExcl = inclToExcl(nextIncl, vatPct);
        } else if (source === 'excl') {
          nextIncl = exclToIncl(nextExcl, vatPct);
        } else if (source === 'margePct') {
          const margePctClamped = clamp(margePct, 0, 100);
          const nextMargeEuro = nextExcl * (margePctClamped / 100);
          nextInkoop = Math.max(0, nextExcl - nextMargeEuro);
        } else if (source === 'margeEuro') {
          const margeEuroClamped = clamp(margeEuro, 0, Math.max(0, nextExcl));
          nextInkoop = Math.max(0, nextExcl - margeEuroClamped);
        }

        nextInkoop = Math.max(0, nextInkoop);
        const margins = computeMargins({ verkoopExcl: nextExcl, inkoop: nextInkoop });
        if (inkoopInput) inkoopInput.value = round2(nextInkoop).toFixed(2);
        if (inclInput) inclInput.value = round2(nextIncl).toFixed(2);
        if (exclEl) exclEl.value = round2(nextExcl).toFixed(2);
        if (margeEl) margeEl.value = round2(clamp(margins.margeEuro, 0, Math.max(0, nextExcl))).toFixed(2);
        if (margePctEl) margePctEl.value = `${round2(clamp(margins.margePct, 0, 100)).toFixed(2)}%`;
        const draft = rowById(rowEl.getAttribute('data-price-id'));
        if (draft) {
          const nameInput = rowEl.querySelector('[data-f="naam"]');
          draft.naam = String(nameInput?.value || draft.naam || '').trim();
          draft.inkoopprijs = round2(nextInkoop);
          draft.verkoopprijsInclBtw = round2(nextIncl);
        }
      };
      const nameInput = rowEl.querySelector('[data-f="naam"]');
      nameInput?.addEventListener('input', () => {
        const draft = rowById(rowEl.getAttribute('data-price-id'));
        if (draft) draft.naam = String(nameInput.value || '').trim();
      });
      inkoopInput?.addEventListener('input', () => recalcFrom('inkoop'));
      inclInput?.addEventListener('input', () => recalcFrom('incl'));
      exclEl?.addEventListener('input', () => recalcFrom('excl'));
      margeEl?.addEventListener('input', () => recalcFrom('margeEuro'));
      margePctEl?.addEventListener('input', () => recalcFrom('margePct'));
      recalcFrom('incl');
    });
    bindDelete();
  }

  function productsForActiveCategory() {
    const source = isEditingProducts ? draftRows : rows;
    const q = String(document.getElementById('pricesSearch')?.value || '').toLowerCase().trim();
    return source.filter((x) => {
      if (String(x.categorie || x.category || '') !== activeCategory) return false;
      if (!q) return true;
      const aliases = Array.isArray(x.aliases) ? x.aliases.join(' ') : String(x.aliases || '');
      const haystack = [
        x.naam,
        x.name,
        x.description,
        x.sku,
        x.categorie,
        x.category,
        x.searchText,
        aliases,
      ]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');
      return haystack.includes(q);
    });
  }

  function renderSummary(list) {
    const el = document.getElementById('pricesSummaryBar');
    if (!el) return;
    const count = list.length;
    const pctForRow = (row) => {
      const margins = computeMargins({ verkoopExcl: deriveVerkoopExcl(row), inkoop: Number(row.inkoopprijs || 0) });
      return margins.margePct;
    };
    const avgMargePct = count
      ? Math.round((list.reduce((s, x) => s + pctForRow(x), 0) / count) * 100) / 100
      : 0;
    const lowest = [...list].sort((a, b) => pctForRow(a) - pctForRow(b))[0];
    el.innerHTML = `<div class="panel-card" style="padding:10px 12px"><strong>${count}</strong> producten · Gem. marge <strong>${avgMargePct.toFixed(2)}%</strong> · Laagste marge: <strong>${escapeAttr(lowest?.naam || '-')}</strong></div>`;
  }

  function renderTable() {
    const el = document.getElementById('pricesTable');
    if (!el) return;
    const list = productsForActiveCategory();
    renderSummary(list);
    el.innerHTML = `<thead><tr><th>SKU</th><th>Naam</th><th>Inkoopprijs</th><th>Verkoopprijs incl. BTW</th><th>Verkoopprijs excl. BTW</th><th>Marge €</th><th>Marge %</th>${isEditingProducts ? '<th></th>' : ''}</tr></thead><tbody>${
      list
        .map(
          (r) => {
            const incl = Number(r.verkoopprijsInclBtw ?? r.price ?? 0);
            const excl = deriveVerkoopExcl(r);
            const margins = computeMargins({ verkoopExcl: excl, inkoop: Number(r.inkoopprijs || 0) });
            if (!isEditingProducts) {
              return `<tr><td><span style="font-size:12px;color:#7f8792;white-space:nowrap">${escapeAttr(r.sku || '-')}</span></td><td>${escHtml(r.naam || r.description || '-')}</td><td>${euro(Number(r.inkoopprijs || 0))}</td><td>${euro(incl)}</td><td>${euro(excl)}</td><td>${euro(margins.margeEuro)}</td><td>${round2(margins.margePct).toFixed(2)}%</td></tr>`;
            }
            return `<tr data-price-id="${r.id}" data-sku="${escapeAttr(r.sku || '')}" data-categorie="${escapeAttr(r.categorie || '')}" data-vat-pct="${Number(r.btwPct || 21)}"><td><span style="font-size:12px;color:#7f8792;white-space:nowrap">${escapeAttr(r.sku || '-')}</span></td><td><input class="field-input" data-f="naam" value="${escapeAttr(r.naam || r.description || '')}"></td><td><div style="display:flex;align-items:center;gap:6px"><span style="color:#7f8792">€</span><input class="field-input" style="max-width:130px" type="number" step="0.01" min="0" data-f="inkoopprijs" value="${toInput(round2(Number(r.inkoopprijs || 0)).toFixed(2))}"></div></td><td><div style="display:flex;align-items:center;gap:6px"><span style="color:#7f8792">€</span><input class="field-input" style="max-width:130px" type="number" step="0.01" min="0" data-f="verkoopprijsInclBtw" value="${toInput(round2(incl).toFixed(2))}"></div></td><td><input class="field-input" style="max-width:130px" type="number" step="0.01" data-f="verkoopprijsExclBtw" value="${toInput(round2(excl).toFixed(2))}"></td><td><input class="field-input" style="max-width:120px" type="number" step="0.01" data-f="marge" value="${toInput(round2(margins.margeEuro).toFixed(2))}"></td><td><input class="field-input" style="max-width:100px" data-f="margePct" value="${toInput(`${round2(margins.margePct).toFixed(2)}%`)}"></td><td><button class="today-btn today-btn--ghost" data-price-delete="${r.id}">Verwijderen</button></td></tr>`;
          }
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

  async function render(shouldReload = true) {
    try {
      if (shouldReload) await load();
      if (isEditingProducts && (!draftRows.length || shouldReload)) cloneRowsForDraft();
      if (!CATEGORY_OPTIONS.includes(activeCategory)) activeCategory = 'Kranen';
      syncEditButtons();
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
    render(false);
  }

  function bindSearch() {
    document.getElementById('pricesSearch')?.addEventListener('input', () => renderTable());
  }

  function cancelEditMode() {
    isEditingProducts = false;
    draftRows = [];
    void render(true);
  }

  async function toggleEditMode() {
    if (!isEditingProducts) {
      isEditingProducts = true;
      cloneRowsForDraft();
      syncEditButtons();
      renderTable();
      return;
    }
    await saveEditedRows();
    isEditingProducts = false;
    draftRows = [];
    await render(true);
  }

  bindSearch();
  global.HKPlannerPrices = { render, openCreateModal, setCategory, toggleEditMode, cancelEditMode };
})(window);
