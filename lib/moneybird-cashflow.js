const MB_BASE = 'https://moneybird.com/api/v2';
const MB_TOKEN = process.env.MONEYBIRD_API_TOKEN;
const MB_ADMIN = process.env.MONEYBIRD_ADMINISTRATION_ID;

function assertConfigured() {
  if (!MB_TOKEN || !MB_ADMIN) {
    throw new Error('Moneybird niet geconfigureerd (MONEYBIRD_API_TOKEN/MONEYBIRD_ADMINISTRATION_ID)');
  }
}

function mbHeaders() {
  return {
    Authorization: `Bearer ${MB_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    const txt = await res.text().catch(() => '');
    return txt || null;
  }
}

async function mbRequest(path, options = {}) {
  assertConfigured();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${MB_BASE}/${MB_ADMIN}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...mbHeaders(),
        ...(options.headers || {}),
      },
    });
    const body = await readJsonSafe(res);
    if (!res.ok) {
      const details = typeof body === 'string' ? body : JSON.stringify(body || {});
      throw new Error(`Moneybird request failed (${options.method || 'GET'} ${path}): ${details.slice(0, 350)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').replace(',', '.').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function monthKeyFromInvoice(inv = {}) {
  const raw = inv.paid_at || inv.paid_date || inv.payment_date || inv.date || '';
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}`;
}

function amountFromSalesInvoice(inv = {}) {
  return Math.max(
    0,
    parseNum(inv.total_paid),
    parseNum(inv.total_price_incl_tax),
    parseNum(inv.total_price_excl_tax),
    parseNum(inv.total_unpaid)
  );
}

function amountFromPurchaseInvoice(inv = {}) {
  return Math.max(
    0,
    parseNum(inv.total_paid),
    parseNum(inv.total_price_incl_tax),
    parseNum(inv.total_price_excl_tax),
    parseNum(inv.price)
  );
}

function isPaidState(inv = {}) {
  return String(inv.state || '').toLowerCase() === 'paid';
}

async function listPaged(pathBase, maxPages = 20) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = pathBase.includes('?') ? '&' : '?';
    const data = await mbRequest(`${pathBase}${sep}page=${page}`, { method: 'GET' });
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

function monthWindow(count = 6) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = count - 1; i >= 0; i -= 1) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export async function getMoneybirdCashflowByMonth() {
  const months = monthWindow(6);
  const map = Object.fromEntries(months.map((m) => [m, { maand: m, inkomsten: 0, kosten: 0, netto: 0 }]));

  const [sales, purchases] = await Promise.all([
    listPaged('/sales_invoices.json'),
    listPaged('/documents/purchase_invoices.json'),
  ]);

  for (const inv of sales) {
    if (!isPaidState(inv)) continue;
    const mk = monthKeyFromInvoice(inv);
    if (!map[mk]) continue;
    map[mk].inkomsten += amountFromSalesInvoice(inv);
  }
  for (const inv of purchases) {
    if (!isPaidState(inv)) continue;
    const mk = monthKeyFromInvoice(inv);
    if (!map[mk]) continue;
    map[mk].kosten += amountFromPurchaseInvoice(inv);
  }

  return months.map((m) => {
    const row = map[m];
    row.inkomsten = Math.round(row.inkomsten * 100) / 100;
    row.kosten = Math.round(row.kosten * 100) / 100;
    row.netto = Math.round((row.inkomsten - row.kosten) * 100) / 100;
    return row;
  });
}
