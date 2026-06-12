(function initPlannerInventory(global) {
  const SHOW_INVENTORY_WARNINGS_UI = false; // true = gele waarschuwingenlijst boven voorraadtabel

  let items = [];
  let warnings = [];
  let isEditingInventory = false;
  const draftMinStockById = new Map();
  let deleteOverlay = null;
  let deleteEscHandler = null;

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return global.HKPlannerAuthSession?.hkAuthHeader?.({ localStorageImpl: global.localStorage, documentRef: document }) || '';
  }

  function statusFor(item) {
    if (item.stock <= 0) return 'out';
    if (item.stock < item.minStock) return 'low';
    return 'ok';
  }

  async function load() {
    const res = await fetch('/api/inventory', { headers: { 'X-HK-Auth': authHeader() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kon voorraad niet laden');
    items = Array.isArray(data.items) ? data.items : [];
  }

  async function loadWarnings() {
    const res = await fetch('/api/inventory?action=warnings', { headers: { 'X-HK-Auth': authHeader() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kon voorraadwaarschuwingen niet laden');
    warnings = Array.isArray(data.warnings) ? data.warnings : [];
  }

  async function adjust(id, delta) {
    await fetch('/api/inventory?action=adjust', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
      body: JSON.stringify({ id, delta }),
    });
    await render();
  }

  function escHtml(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function syncEditButtons() {
    const toggleBtn = document.getElementById('inventoryEditToggleBtn');
    const cancelBtn = document.getElementById('inventoryEditCancelBtn');
    if (toggleBtn) toggleBtn.textContent = isEditingInventory ? 'Opslaan' : 'Bewerk';
    if (cancelBtn) cancelBtn.style.display = isEditingInventory ? '' : 'none';
  }

  function initializeDraftMinStocks() {
    draftMinStockById.clear();
    for (const item of items) {
      draftMinStockById.set(String(item.id || ''), Number(item.minStock || 0));
    }
  }

  async function saveMinStockEdits() {
    for (const item of items) {
      const id = String(item.id || '');
      if (!id) continue;
      const nextMin = Math.max(0, Math.floor(Number(draftMinStockById.get(id) ?? item.minStock ?? 0)));
      const currMin = Math.max(0, Math.floor(Number(item.minStock || 0)));
      if (nextMin === currMin) continue;
      await fetch('/api/inventory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
        body: JSON.stringify({ id, stock: Number(item.stock || 0), minStock: nextMin }),
      });
    }
  }

  function renderTable() {
    const table = document.getElementById('inventoryTable');
    const q = String(document.getElementById('inventorySearch')?.value || '').toLowerCase().trim();
    const cat = String(document.getElementById('inventoryCategoryFilter')?.value || '');
    if (!table) return;
    table.classList.toggle('inventory-table--editing', isEditingInventory);
    const filtered = items.filter((x) => {
      if (q && !String(x.name || '').toLowerCase().includes(q)) return false;
      if (cat && String(x.category || '') !== cat) return false;
      return true;
    });
    const groups = ['Kranen', 'Quookers', 'Serviceproducten'];
    const groupedRows = [];
    for (const group of groups) {
      const rowsForGroup = filtered.filter((x) => String(x.category || '') === group);
      if (!rowsForGroup.length) continue;
      groupedRows.push(`<tr class="inventory-group-row"><td colspan="${isEditingInventory ? 7 : 6}" style="background:#f8f9fb;font-weight:600;color:#475569">${group}</td></tr>`);
      groupedRows.push(
        ...rowsForGroup.map((x) => {
          const st = statusFor(x);
          const label = st === 'out' ? 'Uitverkocht' : st === 'low' ? 'Bestellen' : 'OK';
          const draftMin = Number(draftMinStockById.get(String(x.id || '')) ?? x.minStock ?? 0);
          const minCell = isEditingInventory
            ? `<input class="field-input" type="number" min="0" step="1" data-minstock-id="${x.id}" value="${Math.max(0, Math.floor(draftMin))}" style="max-width:92px">`
            : String(x.minStock);
          const actionsCell = isEditingInventory
            ? `<div class="inventory-row-actions"><button class="chip-btn" type="button" data-adjust="-1" data-id="${x.id}">-</button><button class="chip-btn" type="button" data-adjust="1" data-id="${x.id}">+</button><button class="chip-btn" type="button" data-delete-id="${x.id}">Verwijderen</button></div>`
            : '';
          const rowClass = isEditingInventory ? ' class="inventory-edit-row"' : '';
          const nameCell = isEditingInventory ? `<td data-label="Naam">${escHtml(x.name)}</td>` : `<td>${escHtml(x.name)}</td>`;
          const catCell = isEditingInventory ? `<td data-label="Categorie">${escHtml(x.category)}</td>` : `<td>${escHtml(x.category)}</td>`;
          const stockCell = isEditingInventory ? `<td data-label="Voorraad">${x.stock}</td>` : `<td>${x.stock}</td>`;
          const minTd = isEditingInventory ? `<td data-label="Minimum">${minCell}</td>` : `<td>${minCell}</td>`;
          const priceCell = isEditingInventory
            ? `<td data-label="Inkoopprijs">€ ${Number(x.inkoopprijs || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`
            : `<td>€ ${Number(x.inkoopprijs || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
          const statusCell = isEditingInventory
            ? `<td data-label="Status"><span class="status-pill ${st}">${label}</span></td>`
            : `<td><span class="status-pill ${st}">${label}</span></td>`;
          const actionsTd = isEditingInventory
            ? `<td class="inventory-actions-cell" data-label="Acties">${actionsCell}</td>`
            : '';
          return `<tr${rowClass}>${nameCell}${catCell}${stockCell}${minTd}${priceCell}${statusCell}${actionsTd}</tr>`;
        })
      );
    }
    table.innerHTML = `<thead><tr><th>Naam</th><th>Categorie</th><th>Voorraad</th><th>Minimum</th><th>Inkoopprijs</th><th>Status</th>${isEditingInventory ? '<th></th>' : ''}</tr></thead><tbody>${groupedRows.join('')}</tbody>`;
    table.querySelectorAll('[data-minstock-id]').forEach((input) => {
      input.addEventListener('input', () => {
        const id = String(input.getAttribute('data-minstock-id') || '');
        if (!id) return;
        const next = Math.max(0, Math.floor(Number(input.value || 0)));
        draftMinStockById.set(id, next);
      });
    });
    if (!isEditingInventory) return;
    table.querySelectorAll('[data-adjust]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const delta = Number(btn.getAttribute('data-adjust') || '0');
        if (!id || !delta) return;
        await adjust(id, delta);
      });
    });
    table.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-delete-id');
        const item = items.find((x) => String(x.id) === String(id));
        if (!id || !item) return;
        openDeleteModal(item);
      });
    });
  }

  function renderCategoryFilter() {
    const el = document.getElementById('inventoryCategoryFilter');
    if (!el) return;
    const cats = Array.from(new Set(items.map((x) => String(x.category || '').trim()).filter(Boolean))).sort();
    const curr = el.value || '';
    el.innerHTML = `<option value="">Alle categorieën</option>${cats.map((c) => `<option value="${c}">${c}</option>`).join('')}`;
    if (curr && cats.includes(curr)) el.value = curr;
  }

  async function render() {
    try {
      const loads = [load()];
      if (SHOW_INVENTORY_WARNINGS_UI) loads.push(loadWarnings());
      await Promise.all(loads);
      if (isEditingInventory && !draftMinStockById.size) initializeDraftMinStocks();
      syncEditButtons();
      renderCategoryFilter();
      renderWarnings();
      renderTable();
    } catch (err) {
      const table = document.getElementById('inventoryTable');
      if (table) table.innerHTML = `<tbody><tr><td>${String(err.message || err)}</td></tr></tbody>`;
    }
  }

  function ensureWarningsContainer() {
    const panel = document.getElementById('panelInventory');
    if (!panel) return null;
    let el = document.getElementById('inventoryWarnings');
    if (el) return el;
    const content = panel.querySelector('.panel-page-content');
    if (!content) return null;
    el = document.createElement('div');
    el.id = 'inventoryWarnings';
    el.style.display = 'grid';
    el.style.gap = '8px';
    el.style.marginBottom = '10px';
    content.insertBefore(el, content.firstChild || null);
    return el;
  }

  function renderWarnings() {
    if (!SHOW_INVENTORY_WARNINGS_UI) return;
    const el = ensureWarningsContainer();
    if (!el) return;
    if (!warnings.length) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'grid';
    el.innerHTML = warnings
      .map((w) => {
        const name = escHtml(String(w?.itemName || 'Onbekend artikel'));
        const stock = Number(w?.stock) || 0;
        const minStock = Number(w?.minStock) || 0;
        return `<div style="background:#fff7e6;border:1px solid #ffd8a8;color:#8a5a00;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.35">${name} — nog ${stock} op voorraad (minimum: ${minStock})</div>`;
      })
      .join('');
  }

  function removeDeleteModal() {
    if (deleteOverlay?.parentNode) deleteOverlay.parentNode.removeChild(deleteOverlay);
    deleteOverlay = null;
    if (deleteEscHandler) document.removeEventListener('keydown', deleteEscHandler);
    deleteEscHandler = null;
  }

  function openDeleteModal(item) {
    removeDeleteModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="modal" style="max-width:460px" role="dialog" aria-modal="true" aria-labelledby="inventoryDeleteTitle">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div class="modal-title" id="inventoryDeleteTitle" style="margin:0">Artikel verwijderen</div>
          <button type="button" class="btn-cancel" data-close-inventory-delete>✕</button>
        </div>
        <div class="form-row">
          <div class="form-label" style="text-transform:none;font-size:14px;font-weight:500">Weet je zeker dat je <strong>${escHtml(item.name)}</strong> wilt verwijderen?</div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-cancel" data-close-inventory-delete>Annuleren</button>
          <button type="button" class="btn-save" id="inventoryDeleteConfirmBtn">Verwijderen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    deleteOverlay = overlay;
    const close = () => removeDeleteModal();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll('[data-close-inventory-delete]').forEach((btn) => btn.addEventListener('click', close));
    deleteEscHandler = (e) => {
      if (e.key === 'Escape' && deleteOverlay) close();
    };
    document.addEventListener('keydown', deleteEscHandler);
    overlay.querySelector('#inventoryDeleteConfirmBtn')?.addEventListener('click', async () => {
      await fetch(`/api/inventory?id=${encodeURIComponent(String(item.id || ''))}`, {
        method: 'DELETE',
        headers: { 'X-HK-Auth': authHeader() },
      });
      close();
      await render();
    });
    overlay.querySelector('#inventoryDeleteConfirmBtn')?.focus();
  }

  function bindFilters() {
    document.getElementById('inventorySearch')?.addEventListener('input', () => renderTable());
    document.getElementById('inventoryCategoryFilter')?.addEventListener('change', () => renderTable());
  }

  bindFilters();
  function cancelEditMode() {
    isEditingInventory = false;
    draftMinStockById.clear();
    syncEditButtons();
    renderTable();
  }

  async function toggleEditMode() {
    if (!isEditingInventory) {
      isEditingInventory = true;
      initializeDraftMinStocks();
      syncEditButtons();
      renderTable();
      return;
    }
    await saveMinStockEdits();
    isEditingInventory = false;
    draftMinStockById.clear();
    await render();
  }

  global.HKPlannerInventory = { render, openCreateModal: () => {}, toggleEditMode, cancelEditMode };
})(window);
