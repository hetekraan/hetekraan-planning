(function initPlannerPrices(global) {
  let rows = [];
  let draftRows = [];
  let isEditingProducts = false;
  let activeCategory = 'Kranen';
  let createOverlay = null;
  let deleteOverlay = null;
  let createEscHandler = null;
  let deleteEscHandler = null;
  const CATEGORY_OPTIONS = ['Kranen', 'Quookers', 'Serviceproducten', 'Diensten'];

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return global.HKPlannerAuthSession?.hkAuthHeader?.({ localStorageImpl: global.localStorage, documentRef: document }) || '';
  }

  async function load() {
    const res = await fetch('/api/prices', { headers: { 'X-HK-Auth': authHeader() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kon prijzen niet laden');
    rows = Array.isArray(data.items) ? data.items : [];
    // [prices][diag] TIJDELIJK — verwijder na bevestiging sleepvolgorde
    try {
      console.info(
        '[prices][diag] loaded from redis',
        rows.slice(0, 12).map((r) => ({ id: String(r.id), cat: r.categorie || r.category, sortOrder: r.sortOrder }))
      );
    } catch (_) {}
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

  /** Parse NL/EN decimaal: strip €/spaties, komma → punt. Leeg/partial → NaN (niet stiekem 0). */
  function parseDecimal(raw) {
    const s = String(raw ?? '')
      .replace(/[^0-9.,-]/g, '')
      .replace(',', '.');
    if (s === '' || s === '-' || s === '.') return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  /** Zelfde als parseDecimal maar NaN → 0, voor berekeningen. */
  function numFrom(raw) {
    const n = parseDecimal(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function orderOf(row) {
    const n = Number(row?.sortOrder);
    return Number.isFinite(n) ? n : Infinity;
  }

  function currentQuery() {
    return String(document.getElementById('pricesSearch')?.value || '').toLowerCase().trim();
  }

  function matchesQuery(x, q) {
    const aliases = Array.isArray(x.aliases) ? x.aliases.join(' ') : String(x.aliases || '');
    const haystack = [x.naam, x.name, x.description, x.sku, x.categorie, x.category, x.searchText, aliases]
      .map((v) => String(v || '').toLowerCase())
      .join(' ');
    return haystack.includes(q);
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
          ...(Number.isFinite(Number(r.sortOrder)) ? { sortOrder: Number(r.sortOrder) } : {}),
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

      /** Schrijf een numeriek veld terug (2 decimalen), maar NOOIT het veld waarin de gebruiker typt. */
      const writeField = (el, val, activeEl) => {
        if (!el || el === activeEl) return;
        el.value = round2(val).toFixed(2);
      };
      const writePct = (el, val, activeEl) => {
        if (!el || el === activeEl) return;
        el.value = `${round2(clamp(val, 0, 100)).toFixed(2)}%`;
      };

      const recalc = (source, activeEl) => {
        let nextInkoop = numFrom(inkoopInput?.value);
        let nextIncl = numFrom(inclInput?.value);
        let nextExcl = numFrom(exclEl?.value);
        const margeEuro = numFrom(margeEl?.value);
        const margePct = numFrom(String(margePctEl?.value || '').replace('%', ''));

        // Canonical: alle marge-berekeningen gaan via verkoopExcl.
        if (source === 'incl') {
          nextExcl = inclToExcl(nextIncl, vatPct);
        } else if (source === 'excl') {
          nextIncl = exclToIncl(nextExcl, vatPct);
        } else if (source === 'margePct') {
          const c = clamp(margePct, 0, 100);
          nextInkoop = Math.max(0, nextExcl - nextExcl * (c / 100));
        } else if (source === 'margeEuro') {
          const c = clamp(margeEuro, 0, Math.max(0, nextExcl));
          nextInkoop = Math.max(0, nextExcl - c);
        }

        nextInkoop = Math.max(0, nextInkoop);
        const margins = computeMargins({ verkoopExcl: nextExcl, inkoop: nextInkoop });

        // Alleen de AFGELEIDE velden bijwerken; het actieve veld blijft ongemoeid (raw string).
        writeField(inkoopInput, nextInkoop, activeEl);
        writeField(inclInput, nextIncl, activeEl);
        writeField(exclEl, nextExcl, activeEl);
        writeField(margeEl, clamp(margins.margeEuro, 0, Math.max(0, nextExcl)), activeEl);
        writePct(margePctEl, margins.margePct, activeEl);

        const draft = rowById(rowEl.getAttribute('data-price-id'));
        if (draft) {
          const nameInputEl = rowEl.querySelector('[data-f="naam"]');
          draft.naam = String(nameInputEl?.value || draft.naam || '').trim();
          draft.inkoopprijs = round2(nextInkoop);
          draft.verkoopprijsInclBtw = round2(nextIncl);
        }
      };

      /** Tijdens typen: alleen afgeleide velden herberekenen, actief veld raw laten. */
      const bindField = (el, source, isPct = false) => {
        if (!el) return;
        el.addEventListener('input', () => recalc(source, el));
        el.addEventListener('blur', () => {
          // Pas op blur normaliseren; leeg veld → 0.
          if (isPct) {
            el.value = `${round2(clamp(numFrom(String(el.value).replace('%', '')), 0, 100)).toFixed(2)}%`;
          } else {
            el.value = round2(numFrom(el.value)).toFixed(2);
          }
          recalc(source, null);
        });
      };

      const nameInput = rowEl.querySelector('[data-f="naam"]');
      nameInput?.addEventListener('input', () => {
        const draft = rowById(rowEl.getAttribute('data-price-id'));
        if (draft) draft.naam = String(nameInput.value || '').trim();
      });
      bindField(inkoopInput, 'inkoop');
      bindField(inclInput, 'incl');
      bindField(exclEl, 'excl');
      bindField(margeEl, 'margeEuro');
      bindField(margePctEl, 'margePct', true);
      // Eenmalige initiële sync (geen actief veld) — hindert het typen niet.
      recalc('incl', null);
    });
    bindDelete();
  }

  let dragSrcId = null;

  function bindDrag() {
    document.querySelectorAll('#pricesTable tr[data-price-id]').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        dragSrcId = el.getAttribute('data-price-id');
        el.style.opacity = '0.5';
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        el.style.opacity = '';
        document.querySelectorAll('#pricesTable tr[data-price-id]').forEach((x) => {
          x.style.borderTop = '';
        });
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (el.getAttribute('data-price-id') !== dragSrcId) el.style.borderTop = '2px solid #c8a15a';
      });
      el.addEventListener('dragleave', () => {
        el.style.borderTop = '';
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.style.borderTop = '';
        void onDropReorder(dragSrcId, el.getAttribute('data-price-id'));
      });
    });
  }

  function applySortOrder(list) {
    list.forEach((row, idx) => {
      const rowRef = rows.find((x) => String(x.id) === String(row.id));
      if (rowRef) rowRef.sortOrder = idx;
      const draftRef = draftRows.find((x) => String(x.id) === String(row.id));
      if (draftRef) draftRef.sortOrder = idx;
      row.sortOrder = idx;
    });
  }

  async function onDropReorder(srcId, targetId) {
    if (!srcId || !targetId || String(srcId) === String(targetId)) return;
    const list = productsForView();
    const srcIdx = list.findIndex((x) => String(x.id) === String(srcId));
    const tgtIdx = list.findIndex((x) => String(x.id) === String(targetId));
    if (srcIdx < 0 || tgtIdx < 0) return;
    const reordered = list.slice();
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    applySortOrder(reordered);
    renderTable();
    // Eén atomische PATCH i.p.v. N parallelle rewrites (voorkomt last-write-wins race).
    const orderedIds = reordered.map((r) => String(r.id));
    try {
      // [prices][diag] TIJDELIJK — verwijder na bevestiging sleepvolgorde
      console.info('[prices][diag] drop → PATCH reorder', {
        count: orderedIds.length,
        order: reordered.map((r, i) => ({ id: String(r.id), naam: r.naam, sortOrder: i })),
      });
      const res = await fetch('/api/prices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
        body: JSON.stringify({ reorder: orderedIds }),
      });
      const bodyJson = await res.json().catch(() => ({}));
      // [prices][diag] TIJDELIJK — verwijder na bevestiging sleepvolgorde
      console.info('[prices][diag] reorder response', { status: res.status, ok: res.ok, body: bodyJson });
      if (!res.ok) throw new Error(`reorder_failed_${res.status}`);
    } catch (err) {
      console.warn('[prices][diag] reorder failed', err?.message || err);
      if (typeof global.showToast === 'function') global.showToast('Volgorde opslaan mislukt', 'info');
      await render(true);
    }
  }

  /**
   * Lege zoekterm → alleen de actieve categorie, gesorteerd op sortOrder (nulls achteraan, stabiel).
   * Gevulde zoekterm → alle categorieën, gesorteerd op categorie + sortOrder.
   */
  function productsForView() {
    const source = isEditingProducts ? draftRows : rows;
    const q = currentQuery();
    if (q) {
      return source
        .filter((x) => matchesQuery(x, q))
        .map((row, idx) => ({ row, idx }))
        .sort((a, b) => {
          const ca = String(a.row.categorie || a.row.category || '');
          const cb = String(b.row.categorie || b.row.category || '');
          if (ca !== cb) return ca.localeCompare(cb);
          return orderOf(a.row) - orderOf(b.row) || a.idx - b.idx;
        })
        .map((x) => x.row);
    }
    return source
      .filter((x) => String(x.categorie || x.category || '') === activeCategory)
      .map((row, idx) => ({ row, idx }))
      .sort((a, b) => orderOf(a.row) - orderOf(b.row) || a.idx - b.idx)
      .map((x) => x.row);
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

  function buildViewRow(r, opts) {
    const incl = Number(r.verkoopprijsInclBtw ?? r.price ?? 0);
    const excl = deriveVerkoopExcl(r);
    const margins = computeMargins({ verkoopExcl: excl, inkoop: Number(r.inkoopprijs || 0) });
    const catLabel = String(r.categorie || r.category || '-');
    const dragCell = opts.showDrag
      ? '<td class="price-drag-cell" style="cursor:grab;color:#b9b3a9;text-align:center;user-select:none;width:24px" title="Sleep om te herordenen">⠿</td>'
      : '';
    const catCell = opts.showCat
      ? `<td><span style="font-size:11px;color:#7f8792;background:#f2ede3;border-radius:6px;padding:2px 6px;white-space:nowrap">${escapeAttr(catLabel)}</span></td>`
      : '';
    return `<tr data-price-id="${escapeAttr(String(r.id || ''))}" data-categorie="${escapeAttr(catLabel)}"${opts.showDrag ? ' draggable="true"' : ''}>${dragCell}<td><span style="font-size:12px;color:#7f8792;white-space:nowrap">${escapeAttr(r.sku || '-')}</span></td>${catCell}<td>${escHtml(r.naam || r.description || '-')}</td><td>${euro(Number(r.inkoopprijs || 0))}</td><td>${euro(incl)}</td><td>${euro(excl)}</td><td>${euro(margins.margeEuro)}</td><td>${round2(margins.margePct).toFixed(2)}%</td></tr>`;
  }

  function buildEditRow(r, opts) {
    const incl = Number(r.verkoopprijsInclBtw ?? r.price ?? 0);
    const excl = deriveVerkoopExcl(r);
    const margins = computeMargins({ verkoopExcl: excl, inkoop: Number(r.inkoopprijs || 0) });
    const catLabel = String(r.categorie || r.category || '-');
    const catCell = opts.showCat
      ? `<td><span style="font-size:11px;color:#7f8792;background:#f2ede3;border-radius:6px;padding:2px 6px;white-space:nowrap">${escapeAttr(catLabel)}</span></td>`
      : '';
    return `<tr data-price-id="${r.id}" data-sku="${escapeAttr(r.sku || '')}" data-categorie="${escapeAttr(r.categorie || '')}" data-vat-pct="${Number(r.btwPct || 21)}"><td><span style="font-size:12px;color:#7f8792;white-space:nowrap">${escapeAttr(r.sku || '-')}</span></td>${catCell}<td><input class="field-input" data-f="naam" value="${escapeAttr(r.naam || r.description || '')}"></td><td><div style="display:flex;align-items:center;gap:6px"><span style="color:#7f8792">€</span><input class="field-input" style="max-width:130px" type="text" inputmode="decimal" data-f="inkoopprijs" value="${toInput(round2(Number(r.inkoopprijs || 0)).toFixed(2))}"></div></td><td><div style="display:flex;align-items:center;gap:6px"><span style="color:#7f8792">€</span><input class="field-input" style="max-width:130px" type="text" inputmode="decimal" data-f="verkoopprijsInclBtw" value="${toInput(round2(incl).toFixed(2))}"></div></td><td><input class="field-input" style="max-width:130px" type="text" inputmode="decimal" data-f="verkoopprijsExclBtw" value="${toInput(round2(excl).toFixed(2))}"></td><td><input class="field-input" style="max-width:120px" type="text" inputmode="decimal" data-f="marge" value="${toInput(round2(margins.margeEuro).toFixed(2))}"></td><td><input class="field-input" style="max-width:100px" type="text" inputmode="decimal" data-f="margePct" value="${toInput(`${round2(margins.margePct).toFixed(2)}%`)}"></td><td><button class="today-btn today-btn--ghost" data-price-delete="${r.id}">Verwijderen</button></td></tr>`;
  }

  function renderTable() {
    const el = document.getElementById('pricesTable');
    if (!el) return;
    const searching = currentQuery().length > 0;
    const showCat = searching;
    const showDrag = !searching && !isEditingProducts;
    const showActions = isEditingProducts;
    const list = productsForView();
    renderSummary(list);
    const head = `<thead><tr>${showDrag ? '<th></th>' : ''}<th>SKU</th>${showCat ? '<th>Categorie</th>' : ''}<th>Naam</th><th>Inkoopprijs</th><th>Verkoopprijs incl. BTW</th><th>Verkoopprijs excl. BTW</th><th>Marge €</th><th>Marge %</th>${showActions ? '<th></th>' : ''}</tr></thead>`;
    const body = list
      .map((r) => (isEditingProducts ? buildEditRow(r, { showCat }) : buildViewRow(r, { showCat, showDrag })))
      .join('');
    el.innerHTML = `${head}<tbody>${body}</tbody>`;
    if (isEditingProducts) bindInline();
    else if (showDrag) bindDrag();
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
