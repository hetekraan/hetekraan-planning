/**
 * Match een verkochte regel (extra) aan een voorraaditem.
 * Primair via SKU; fallback via product-id (zelfde id als prijsrij),
 * zodat producten zonder SKU (handmatig toegevoegd) toch worden afgeboekt.
 *
 * Normalisatie bewust gelijk aan api/ghl.js completeAppointment-maps.
 */

export function normalizeSku(v) {
  return String(v || '').trim().toLowerCase();
}

export function normalizeNameForMatch(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {Record<string, unknown>} line
 * @param {Map<string, object>} priceById
 * @param {Map<string, object>} priceBySku
 * @param {Map<string, object>} priceByName
 * @returns {string} genormaliseerde SKU of ''
 */
export function resolveLineSku(line, priceById, priceBySku, priceByName) {
  const lineSku = normalizeSku(line?.sku);
  if (lineSku && priceBySku.has(lineSku)) return lineSku;
  const linePriceId = String(line?.priceId || line?.id || '').trim();
  if (linePriceId && priceById.has(linePriceId)) {
    return normalizeSku(priceById.get(linePriceId)?.sku);
  }
  const byName = priceByName.get(normalizeNameForMatch(line?.desc || line?.label || line?.name || ''));
  if (byName) return normalizeSku(byName.sku);
  return '';
}

/**
 * Resolve prijsrij voor een regel (priceId → sku → naam), zelfde volgorde als buslijst.
 * @param {Record<string, unknown>} line
 * @param {{ priceById: Map, priceBySku: Map, priceByName: Map }} maps
 */
export function resolvePriceRowForLine(line, maps) {
  const priceById = maps?.priceById || new Map();
  const priceBySku = maps?.priceBySku || new Map();
  const priceByName = maps?.priceByName || new Map();

  const priceId = String(line?.priceId || line?.price_id || line?.id || '').trim();
  if (priceId && priceById.has(priceId)) return priceById.get(priceId) || null;

  const sku = normalizeSku(line?.sku);
  if (sku && priceBySku.has(sku)) return priceBySku.get(sku) || null;

  const nameKey = normalizeNameForMatch(line?.desc || line?.label || line?.name || line?.description || '');
  if (nameKey && priceByName.has(nameKey)) return priceByName.get(nameKey) || null;

  return null;
}

/**
 * @param {Record<string, unknown>} line
 * @param {{
 *   invBySku: Map<string, object>,
 *   invById: Map<string, object>,
 *   priceById: Map<string, object>,
 *   priceBySku: Map<string, object>,
 *   priceByName: Map<string, object>,
 * }} maps
 * @returns {{ item: object | null, match: 'sku' | 'id_fallback' | 'no_sku_match' | 'no_inventory_item', sku: string, productId: string }}
 */
export function resolveInventoryItemForLine(line, maps) {
  const invBySku = maps?.invBySku || new Map();
  const invById = maps?.invById || new Map();
  const priceById = maps?.priceById || new Map();
  const priceBySku = maps?.priceBySku || new Map();
  const priceByName = maps?.priceByName || new Map();

  const sku = resolveLineSku(line, priceById, priceBySku, priceByName);
  if (sku && invBySku.has(sku)) {
    const item = invBySku.get(sku);
    return {
      item: item || null,
      match: 'sku',
      sku,
      productId: String(item?.id || '').trim(),
    };
  }

  const priceRow = resolvePriceRowForLine(line, { priceById, priceBySku, priceByName });
  const productId = String(priceRow?.id || '').trim();
  if (productId && invById.has(productId)) {
    const item = invById.get(productId);
    return {
      item: item || null,
      match: 'id_fallback',
      sku: normalizeSku(priceRow?.sku) || sku || '',
      productId,
    };
  }

  if (sku) {
    return { item: null, match: 'no_inventory_item', sku, productId: productId || '' };
  }
  return { item: null, match: 'no_sku_match', sku: '', productId: productId || '' };
}
