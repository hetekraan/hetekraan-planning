(function initPlannerInventory(global) {
  let items = [];
  let warnings = [];
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

  function renderTable() {
    const table = document.getElementById('inventoryTable');
    const q = String(document.getElementById('inventorySearch')?.value || '').toLowerCase().trim();
    const cat = String(document.getElementById('inventoryCategoryFilter')?.value || '');
    if (!table) return;
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
      groupedRows.push(`<tr><td colspan="7" style="background:#f8f9fb;font-weight:600;color:#475569">${group}</td></tr>`);
      groupedRows.push(
        ...rowsForGroup.map((x) => {
          const st = statusFor(x);
          const label = st === 'out' ? 'Uitverkocht' : st === 'low' ? 'Laag' : 'OK';
          return `<tr><td>${x.name}</td><td>${x.category}</td><td>${x.stock}</td><td>${x.minStock}</td><td>€ ${Number(x.inkoopprijs || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td><span class="status-pill ${st}">${label}</span></td><td><button class="chip-btn" data-adjust="-1" data-id="${x.id}">-</button> <button class="chip-btn" data-adjust="1" data-id="${x.id}">+</button> <button class="chip-btn" data-delete-id="${x.id}">Verwijderen</button></td></tr>`;
        })
      );
    }
    table.innerHTML = `<thead><tr><th>Naam</th><th>Categorie</th><th>Voorraad</th><th>Minimum</th><th>Inkoopprijs</th><th>Status</th><th></th></tr></thead><tbody>${groupedRows.join('')}</tbody>`;
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
      await Promise.all([load(), loadWarnings()]);
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
  global.HKPlannerInventory = { render, openCreateModal: () => {} };
})(window);
