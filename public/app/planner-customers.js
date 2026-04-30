(function initPlannerCustomers(global) {
  let items = [];
  let loading = false;
  let error = '';
  let loaded = false;

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return global.HKPlannerAuthSession?.hkAuthHeader?.({ localStorageImpl: global.localStorage, documentRef: document }) || '';
  }

  function escHtml(v) {
    return String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function load() {
    loading = true;
    error = '';
    renderTable();
    try {
      const res = await fetch('/api/customers', {
        cache: 'no-store',
        headers: { 'X-HK-Auth': authHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Klanten fout (${res.status})`);
      }
      items = Array.isArray(data?.items) ? data.items : [];
      loaded = true;
    } catch (err) {
      error = String(err?.message || err);
    } finally {
      loading = false;
      renderTable();
    }
  }

  function filteredItems() {
    const q = String(document.getElementById('customersSearch')?.value || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter((row) => {
      const name = String(row?.name || '').toLowerCase();
      const address = String(row?.address || '').toLowerCase();
      const email = String(row?.email || '').toLowerCase();
      return name.includes(q) || address.includes(q) || email.includes(q);
    });
  }

  function renderTable() {
    const table = document.getElementById('customersTable');
    if (!table) return;

    if (loading) {
      table.innerHTML = '<tbody><tr><td>Klanten laden...</td></tr></tbody>';
      return;
    }
    if (error) {
      table.innerHTML = `<tbody><tr><td style="color:var(--reparatie)">${escHtml(error)}</td></tr></tbody>`;
      return;
    }

    const rows = filteredItems();
    table.innerHTML = `
      <thead>
        <tr>
          <th>Naam</th>
          <th>Adres</th>
          <th>Telefoon</th>
          <th>E-mail</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((row) => {
            const badge = row?.hasMoneybird
              ? '<span class="status-pill ok" style="font-size:11px;padding:2px 8px">MB</span>'
              : '';
            return `<tr>
              <td>${escHtml(row?.name || '-')}</td>
              <td>${escHtml(row?.address || '-')}</td>
              <td>${escHtml(row?.phone || '-')}</td>
              <td>${escHtml(row?.email || '-')}</td>
              <td>${badge}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    `;
  }

  function bindSearch() {
    document.getElementById('customersSearch')?.addEventListener('input', () => renderTable());
  }

  function render() {
    renderTable();
    if (!loaded && !loading) void load();
  }

  bindSearch();
  global.HKPlannerCustomers = { render };
})(window);
