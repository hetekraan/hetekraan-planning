/** @typedef {{ id: string, naam?: string, name?: string, sku?: string | null, categorie?: string, category?: string }} PriceRow */
/** @typedef {{ byId: Map<string, PriceRow>, bySku: Map<string, PriceRow> }} PriceCatalogMaps */
/** @typedef {{ naam: string, klant: string }} BuslijstLine */
/** @typedef {Record<string, BuslijstLine[]>} BuslijstGroups */

export const BUSLIJST_GROUP_ORDER = ['Kranen', 'Quookers', 'Serviceproducten'];

const ALLOWED_CATEGORIES = new Set(BUSLIJST_GROUP_ORDER);

export function isValidYmd(ymd) {
  const raw = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymdFromUtcDate(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addDaysYmd(ymd, days) {
  const dt = parseYmd(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymdFromUtcDate(dt);
}

export function amsterdamTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function mondayOfWeekContaining(ymd) {
  const dt = parseYmd(ymd);
  const dow = dt.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return ymdFromUtcDate(dt);
}

/**
 * @param {string} [startDate]
 * @param {string} [fallbackYmd]
 */
export function normalizeWeekStart(startDate, fallbackYmd = amsterdamTodayYmd()) {
  const raw = isValidYmd(startDate) ? String(startDate).trim() : fallbackYmd;
  return mondayOfWeekContaining(raw);
}

/**
 * @param {string} weekStart — maandag YYYY-MM-DD
 * @returns {string[]}
 */
export function getWorkWeekDays(weekStart) {
  const monday = normalizeWeekStart(weekStart);
  return [0, 1, 2, 3, 4].map((i) => addDaysYmd(monday, i));
}

/**
 * @param {string} dateYmd
 */
export function formatBuslijstDayLabel(dateYmd) {
  const formatted = parseYmd(dateYmd).toLocaleDateString('nl-NL', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return String(formatted || dateYmd).toUpperCase();
}

function normalizeSku(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * @param {PriceRow[]} priceRows
 * @returns {PriceCatalogMaps}
 */
export function buildPriceCatalogMaps(priceRows) {
  const byId = new Map();
  const bySku = new Map();
  for (const row of Array.isArray(priceRows) ? priceRows : []) {
    const id = String(row?.id || '').trim();
    if (id) byId.set(id, row);
    const sku = normalizeSku(row?.sku);
    if (sku) bySku.set(sku, row);
  }
  return { byId, bySku };
}

/**
 * Strikte match: priceId of sku in catalogus. Geen naam-fuzzy.
 * @param {Record<string, unknown>} line
 * @param {PriceCatalogMaps} maps
 * @returns {PriceRow | null}
 */
export function resolveCatalogProductStrict(line, maps) {
  const priceId = String(line?.priceId || line?.price_id || line?.id || '').trim();
  if (priceId && maps.byId.has(priceId)) return maps.byId.get(priceId) || null;

  const sku = normalizeSku(line?.sku);
  if (sku && maps.bySku.has(sku)) return maps.bySku.get(sku) || null;

  return null;
}

/**
 * @param {BuslijstGroups} groups
 * @returns {BuslijstGroups}
 */
function omitEmptyGroups(groups) {
  /** @type {BuslijstGroups} */
  const out = {};
  for (const key of BUSLIJST_GROUP_ORDER) {
    const rows = groups[key];
    if (Array.isArray(rows) && rows.length > 0) out[key] = rows;
  }
  return out;
}

/**
 * @param {Array<Record<string, unknown>>} appointments
 * @param {PriceCatalogMaps} maps
 * @param {string} dateYmd
 * @param {Array<{ date: string, productNaam: string, categorie: string, contactId: string | null }>} unknownCollector
 */
function collectGroupsForDay(appointments, maps, dateYmd, unknownCollector) {
  /** @type {BuslijstGroups} */
  const groups = {
    Kranen: [],
    Quookers: [],
    Serviceproducten: [],
  };

  for (const appt of Array.isArray(appointments) ? appointments : []) {
    if (appt?.isCalBlock) continue;
    const klant = String(appt?.name || '').trim() || 'Onbekende klant';
    const contactId = appt?.contactId != null ? String(appt.contactId) : null;
    const extras = Array.isArray(appt?.extras) ? appt.extras : [];

    for (const line of extras) {
      const product = resolveCatalogProductStrict(line, maps);
      if (!product) continue;

      const cat = String(product.categorie || product.category || '').trim();
      if (!ALLOWED_CATEGORIES.has(cat)) {
        unknownCollector.push({
          date: dateYmd,
          productNaam: String(product.naam || product.name || '').trim() || 'Onbekend product',
          categorie: cat || '(leeg)',
          contactId,
        });
        continue;
      }

      const naam = String(product.naam || product.name || '').trim() || 'Onbekend product';
      groups[cat].push({ naam, klant });
    }
  }

  return omitEmptyGroups(groups);
}

/**
 * @param {{
 *   weekStart: string,
 *   listPrices: () => Promise<PriceRow[]>,
 *   loadAppointmentsForDate: (dateYmd: string) => Promise<{ appointments?: Array<Record<string, unknown>> }>,
 * }} input
 */
export async function buildBuslijstWeek(input) {
  const weekStart = normalizeWeekStart(input?.weekStart);
  const priceRows = await input.listPrices();
  const maps = buildPriceCatalogMaps(priceRows);
  const dates = getWorkWeekDays(weekStart);
  const unknownCategories = [];

  const days = await Promise.all(
    dates.map(async (dateYmd) => {
      try {
        const source = await input.loadAppointmentsForDate(dateYmd);
        const appointments = Array.isArray(source?.appointments) ? source.appointments : [];
        const groups = collectGroupsForDay(appointments, maps, dateYmd, unknownCategories);
        return {
          date: dateYmd,
          dayLabel: formatBuslijstDayLabel(dateYmd),
          groups,
        };
      } catch (err) {
        console.warn('[buslijst] day_load_failed', {
          date: dateYmd,
          message: err?.message || String(err),
        });
        return {
          date: dateYmd,
          dayLabel: formatBuslijstDayLabel(dateYmd),
          groups: {},
        };
      }
    })
  );

  if (unknownCategories.length > 0) {
    console.warn('[buslijst] unknown_categories_in_week', {
      weekStart,
      items: unknownCategories,
    });
  }

  return { ok: true, weekStart, days };
}
