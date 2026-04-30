(function initPlannerPrices(global) {
  let rows = [];
  let createOverlay = null;
  let deleteOverlay = null;
  let createEscHandler = null;
  let deleteEscHandler = null;
  const CATEGORY_OPTIONS = ['Installatie', 'Reparatie', 'Onderhoud', 'Arbeid & voorrijkosten'];

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

  function escHtml(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function saveInline(id) {
    const rowEl = document.querySelector(`tr[data-price-id="${id}"]`);
    if (!rowEl) return;
    const description = rowEl.querySelector('[data-f="description"]')?.value || '';
    const priceExVat = Number(rowEl.querySelector('[data-f="priceExVat"]')?.value || 0);
    const vatPct = Number(rowEl.querySelector('[data-f="vatPct"]')?.value || 21);
    const category = rowEl.querySelector('[data-f="category"]')?.value || 'Installatie';
    await fetch('/api/prices', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
      body: JSON.stringify({ id, description, priceExVat, vatPct, category }),
    });
    await render();
  }

  function bindDelete() {
    document.querySelectorAll('[data-price-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-price-delete');
        const row = rows.find((x) => String(x.id) === String(id));
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
    bindDelete();
  }

  function renderTable() {
    const el = document.getElementById('pricesTable');
    if (!el) return;
    el.innerHTML = `<thead><tr><th>Omschrijving</th><th>Prijs ex BTW</th><th>BTW %</th><th>Categorie</th><th></th><th></th></tr></thead><tbody>${
      rows
        .map(
          (r) =>
            `<tr data-price-id="${r.id}"><td><input class="field-input" data-f="description" value="${toInput(r.description)}"></td><td><input class="field-input" type="number" step="0.01" data-f="priceExVat" value="${toInput(r.priceExVat)}"></td><td><input class="field-input" type="number" step="1" data-f="vatPct" value="${toInput(r.vatPct)}"></td><td>${CATEGORY_OPTIONS.includes(String(r.category || '')) ? `<select class="field-input" data-f="category">${CATEGORY_OPTIONS.map((opt) => `<option value="${opt}" ${opt === r.category ? 'selected' : ''}>${opt}</option>`).join('')}</select>` : `<input class="field-input" data-f="category" value="${toInput(r.category)}">`}</td><td><button class="today-btn today-btn--ghost" data-price-save="${r.id}">Opslaan</button></td><td><button class="today-btn today-btn--ghost" data-price-delete="${r.id}">Verwijderen</button></td></tr>`
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
    const description = String(fields.description.value || '').trim();
    const category = String(fields.category.value || '').trim();
    const priceExVat = Number(fields.priceExVat.value);
    const vatPct = Number(fields.vatPct.value);
    const errs = [];
    if (!description) errs.push('Omschrijving is verplicht.');
    if (!category) errs.push('Categorie is verplicht.');
    if (!Number.isFinite(priceExVat) || priceExVat < 0) errs.push('Prijs ex BTW moet een geldig getal zijn.');
    if (!Number.isFinite(vatPct) || vatPct < 0) errs.push('BTW % moet een geldig getal zijn.');
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
          <div class="modal-title" id="pricesCreateTitle" style="margin:0">Nieuwe prijs toevoegen</div>
          <button type="button" class="btn-cancel" data-close-create-modal>✕</button>
        </div>
        <div class="form-row">
          <label class="form-label">Omschrijving</label>
          <input class="form-input" type="text" id="pricesCreateDescription">
        </div>
        <div class="form-row">
          <label class="form-label">SKU (optioneel)</label>
          <input class="form-input" type="text" id="pricesCreateSku">
        </div>
        <div class="form-row">
          <label class="form-label">Categorie</label>
          <select class="form-select" id="pricesCreateCategory">${CATEGORY_OPTIONS.map((x) => `<option value="${x}">${x}</option>`).join('')}</select>
        </div>
        <div class="form-row-2">
          <div>
            <label class="form-label">Prijs ex BTW</label>
            <input class="form-input" type="number" step="0.01" min="0" id="pricesCreatePriceExVat">
          </div>
          <div>
            <label class="form-label">BTW %</label>
            <input class="form-input" type="number" step="1" min="0" id="pricesCreateVatPct" value="21">
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
      description: overlay.querySelector('#pricesCreateDescription'),
      sku: overlay.querySelector('#pricesCreateSku'),
      category: overlay.querySelector('#pricesCreateCategory'),
      priceExVat: overlay.querySelector('#pricesCreatePriceExVat'),
      vatPct: overlay.querySelector('#pricesCreateVatPct'),
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
          description: String(fields.description.value || '').trim(),
          sku: String(fields.sku.value || '').trim() || null,
          category: String(fields.category.value || '').trim(),
          priceExVat: Number(fields.priceExVat.value),
          vatPct: Number(fields.vatPct.value),
        }),
      });
      close();
      await render();
    });
    validateCreateForm(fields, errEl, saveBtn);
    fields.description?.focus();
  }

  function openDeleteModal(row) {
    removeDeleteModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="modal" style="max-width:460px" role="dialog" aria-modal="true" aria-labelledby="pricesDeleteTitle">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div class="modal-title" id="pricesDeleteTitle" style="margin:0">Prijs verwijderen</div>
          <button type="button" class="btn-cancel" data-close-delete-modal>✕</button>
        </div>
        <div class="form-row">
          <div class="form-label" style="text-transform:none;font-size:14px;font-weight:500">Weet je zeker dat je <strong>${escHtml(row.description)}</strong> wilt verwijderen?</div>
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
      renderTable();
    } catch (err) {
      const el = document.getElementById('pricesTable');
      if (el) el.innerHTML = `<tbody><tr><td>${String(err.message || err)}</td></tr></tbody>`;
    }
  }

  global.HKPlannerPrices = { render, openCreateModal };
})(window);
