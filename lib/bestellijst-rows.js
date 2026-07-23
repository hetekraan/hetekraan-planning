/**
 * Pure filter/sort voor de bestellijst — getest in isolation.
 * Houd public/app/planner-bestellijst.js renderTable() in sync.
 */

export function statusForInventoryItem(item) {
  if (Number(item?.stock) <= 0) return 'out';
  if (Number(item?.stock) < Number(item?.minStock)) return 'low';
  return 'ok';
}

/**
 * Toon low + out; out bovenaan, daarna oplopend op stock.
 * @param {Array<{ stock?: number, minStock?: number }>} items
 */
export function filterAndSortBestellijstItems(items) {
  const rows = (Array.isArray(items) ? items : []).filter((x) => {
    const st = statusForInventoryItem(x);
    return st === 'low' || st === 'out';
  });
  rows.sort((a, b) => {
    const sa = statusForInventoryItem(a);
    const sb = statusForInventoryItem(b);
    if (sa !== sb) return sa === 'out' ? -1 : 1;
    return Number(a.stock || 0) - Number(b.stock || 0);
  });
  return rows;
}
