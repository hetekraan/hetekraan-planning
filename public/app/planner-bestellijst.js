(function initPlannerBestellijst(global) {
  let items = [];

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

  // MVP: gedupliceerd van planner-inventory.js + lib/bestellijst-rows.js (geen shared browser-bundle).
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

  function renderTable() {
    const table = document.getElementById('bestellijstTable');
    if (!table) return;
    // Bestellen (low) én Uitverkocht (out). OK blijft verborgen.
    const rows = items
      .filter((x) => {
        const st = statusFor(x);
        return st === 'low' || st === 'out';
      })
      .sort((a, b) => {
        const sa = statusFor(a);
        const sb = statusFor(b);
        if (sa !== sb) return sa === 'out' ? -1 : 1; // uitverkocht bovenaan
        return Number(a.stock || 0) - Number(b.stock || 0);
      });
    if (!rows.length) {
      table.innerHTML =
        '<tbody><tr><td style="padding:18px 12px;color:var(--muted)">Niets te bestellen ✓</td></tr></tbody>';
      return;
    }
    table.innerHTML = `<thead><tr><th>Naam</th><th>SKU</th><th>Voorraad</th><th>Minimum</th><th>Aantal bestellen</th><th>Categorie</th><th>Status</th></tr></thead><tbody>${rows
      .map((x) => {
        const st = statusFor(x);
        const label = st === 'out' ? 'Uitverkocht' : 'Bestellen';
        const orderQty = Math.max(0, Number(x.minStock || 0) - Number(x.stock || 0));
        return `<tr><td>${escHtml(x.name)}</td><td><span style="font-size:12px;color:#7f8792;white-space:nowrap">${escHtml(x.sku || '-')}</span></td><td>${Number(x.stock || 0)}</td><td>${Number(x.minStock || 0)}</td><td>${orderQty}</td><td>${escHtml(x.category || '-')}</td><td><span class="status-pill ${st}">${label}</span></td></tr>`;
      })
      .join('')}</tbody>`;
  }

  async function render() {
    const table = document.getElementById('bestellijstTable');
    try {
      await load();
      renderTable();
    } catch (err) {
      if (table) table.innerHTML = `<tbody><tr><td>${escHtml(String(err.message || err))}</td></tr></tbody>`;
    }
  }

  global.HKPlannerBestellijst = { render };
})(window);
