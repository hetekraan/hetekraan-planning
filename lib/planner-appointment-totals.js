export function calcAppointmentTotal(appointment) {
  const baseRaw = Number(appointment?.price);
  const base = Number.isFinite(baseRaw) ? baseRaw : 0;
  const extrasTotal = (appointment?.extras || []).reduce((sum, extra) => {
    const p = Number(extra?.price);
    return sum + (Number.isFinite(p) ? p : 0);
  }, 0);
  return Math.round((base + extrasTotal) * 100) / 100;
}

const DEFAULT_VAT_FACTOR = 1.21;

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function inclToExcl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return round2(n / DEFAULT_VAT_FACTOR);
}

function normalizeSku(v) {
  return String(v || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeNameForMatch(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, ' ')
    .trim();
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasExplicitCostValue(priceRow) {
  if (!priceRow || typeof priceRow !== 'object') return false;
  const raw = priceRow.inkoopprijs;
  if (raw == null || raw === '') return false;
  return toFiniteNumber(raw) !== null;
}

export function buildPriceMaps(priceRows = []) {
  const rows = Array.isArray(priceRows) ? priceRows : [];
  return {
    byId: new Map(rows.map((p) => [String(p?.id || '').trim(), p])),
    bySku: new Map(
      rows
        .filter((p) => normalizeSku(p?.sku))
        .map((p) => [normalizeSku(p.sku), p])
    ),
    byName: new Map(rows.map((p) => [normalizeNameForMatch(p?.description || p?.name || ''), p])),
  };
}

function matchPriceForLine(line, maps) {
  const sku = normalizeSku(line?.sku);
  if (sku && maps.bySku.has(sku)) return { row: maps.bySku.get(sku), source: 'SKU' };
  const priceId = String(line?.priceId || line?.price_id || '').trim();
  if (priceId && maps.byId.has(priceId)) return { row: maps.byId.get(priceId), source: 'priceId' };
  const nameKey = normalizeNameForMatch(line?.description || line?.desc || line?.label || line?.name || '');
  if (nameKey && maps.byName.has(nameKey)) return { row: maps.byName.get(nameKey), source: 'naam-match' };
  return { row: null, source: 'geen match' };
}

function buildMarginLineItems(appointment, maps) {
  const lines = [];
  const base = Number(appointment?.price || 0);
  if (base > 0) {
    lines.push({ description: 'Basisprijs', verkoopprijs: base, sku: null, priceId: null });
  }
  const extras = Array.isArray(appointment?.extras) ? appointment.extras : [];
  for (const ex of extras) {
    lines.push({
      description: String(ex?.desc || ex?.label || ex?.name || '').trim() || 'Onbekend',
      verkoopprijs: Number(ex?.price || 0),
      sku: String(ex?.sku || '').trim() || null,
      priceId: String(ex?.priceId || ex?.price_id || '').trim() || null,
    });
  }
  return lines.map((ln) => {
    const matched = matchPriceForLine(ln, maps);
    const verkoop = round2(Number(ln.verkoopprijs || 0));
    const verkoopExcl = inclToExcl(verkoop);
    const hasKnownCost = hasExplicitCostValue(matched?.row);
    const inkoop = hasKnownCost ? round2(Number(matched.row.inkoopprijs || 0)) : null;
    const marge = hasKnownCost ? round2(verkoopExcl - Number(inkoop || 0)) : null;
    return {
      omschrijving: ln.description,
      verkoopprijs: verkoop,
      verkoopprijsExcl: verkoopExcl,
      inkoopprijs: inkoop,
      marge,
      costKnown: hasKnownCost,
      matchBron: matched.source,
      sku: ln.sku || null,
      priceId: ln.priceId || null,
    };
  });
}

export function computeAppointmentAnalytics(appointment, mapsOrPriceRows = null) {
  const maps = mapsOrPriceRows && mapsOrPriceRows.byId && mapsOrPriceRows.bySku && mapsOrPriceRows.byName
    ? mapsOrPriceRows
    : buildPriceMaps(Array.isArray(mapsOrPriceRows) ? mapsOrPriceRows : []);
  const lineBreakdown = buildMarginLineItems(appointment, maps);
  const totalRevenueExcl = round2(lineBreakdown.reduce((s, ln) => s + Number(ln.verkoopprijsExcl || 0), 0));
  const totalCost = round2(lineBreakdown.reduce((s, ln) => (ln.costKnown ? s + Number(ln.inkoopprijs || 0) : s), 0));
  const margin = round2(totalRevenueExcl - totalCost);
  const costKnown = lineBreakdown.every((ln) => ln.costKnown);
  const marginPct = totalRevenueExcl > 0 ? round2((margin / totalRevenueExcl) * 100) : 0;
  return {
    totalRevenueExcl,
    totalCost,
    margin,
    marginPct,
    costKnown,
    lineBreakdown,
  };
}
