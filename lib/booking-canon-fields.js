export const BOOKING_FORM_FIELD_IDS = {
  email: '2mm3mEqQIYWWROAl1mnt',
  straat_huisnummer: 'AcxgtdoXkOLpvVz2SWrc',
  prijs_regels: 'F3PFZSxBQEV02jFJfl8C',
  type_onderhoud: 'O9ZIqwzxHl60owXwddzS',
  tijdslot: 'T69BCnexHHhco2vTKBax',
  probleemomschrijving: 'ZdgaJPhEvWxYQQ5WL9PW',
  betaal_status: 'j7QAtMcnKBXwdPA8Axaq',
  woonplaats: 'kyvJMefhpt7GHLYoUvxy',
  prijs_totaal: 'vMWmccNgTRjzKdcnLePR',
  postcode: 'xMHjIkr21Ke6iMm9udy7',
  boekingsvoorstel_optie_1: 'XsKJl0v34MZIu1Bkrsu5',
  boekingsvoorstel_optie_2: 'iucDg0bMq9ypVXy0m0SN',
  boekingsvoorstel_status: 'UF6FNr2OqidQBVtmrL18',
  boeking_bevestigd_datum: 'C17Z7eX31XTjbSDttlaB',
  boeking_bevestigd_dagdeel: '7ozUoUQ89dgulxKGRWF6',
  boeking_bevestigd_status: 'o4KgjJSmYEPEYnlCeYA2',
};

function normalizeText(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || s.toLowerCase() === 'null') return '';
  return s;
}

export function toPriceNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).replace(',', '.').replace(/[^\d.-]/g, '');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Dashboard / GHL: één rij = { desc, price } (euros, 2 decimalen).
 * Accepteert legacy keys label|desc|… en amount|price|value.
 */
export function normalizePriceLineItems(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const desc = normalizeText(
      row.desc ?? row.label ?? row.omschrijving ?? row.name ?? row.title ?? ''
    );
    const n = toPriceNumber(row.price ?? row.amount ?? row.value ?? '');
    if (!desc || n === null || n < 0) continue;
    out.push({ desc, price: n });
  }
  return out;
}

/**
 * Parse `boekingsformulier_prijs_regels` of legacy tekst: `label|amount` per regel, of JSON-array.
 */
export function parseStructuredPriceRulesString(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      return normalizePriceLineItems(JSON.parse(s));
    } catch {
      return [];
    }
  }
  const lines = s.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out = [];
  for (const row of lines) {
    const pipe = row.indexOf('|');
    if (pipe < 0) continue;
    const label = row.slice(0, pipe).trim();
    const amountStr = row.slice(pipe + 1).trim();
    const n = toPriceNumber(amountStr);
    if (!label || n === null || n < 0) continue;
    out.push({ desc: label, price: n });
  }
  return out;
}

function formatPriceNumber(value) {
  if (value === undefined || value === null || value === '') return '';
  const n = Number(value);
  if (Number.isFinite(n)) return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return normalizeText(value);
}

export function formatPriceRulesStructuredString(priceRules) {
  if (priceRules === undefined || priceRules === null || priceRules === '') return '';
  let rows = priceRules;
  if (typeof rows === 'string') {
    const t = rows.trim();
    if (!t) return '';
    if (t.startsWith('[')) {
      try {
        rows = JSON.parse(t);
      } catch {
        return normalizeText(t);
      }
    } else {
      rows = parseStructuredPriceRulesString(t);
    }
  }
  if (!Array.isArray(rows)) return '';
  rows = normalizePriceLineItems(rows);
  if (rows.length === 0) return '';
  const lines = [];
  for (const row of rows) {
    lines.push(`${row.desc}|${formatPriceNumber(row.price)}`);
  }
  return lines.join('\n');
}

export function appendBookingCanonFields(customFields, values) {
  const out = Array.isArray(customFields) ? customFields : [];
  const written = {};
  const push = (id, value) => {
    const s = normalizeText(value);
    if (!s) return;
    out.push({ id, value: s, field_value: s });
  };
  if (!values || typeof values !== 'object') return { customFields: out, written };

  push(BOOKING_FORM_FIELD_IDS.email, values.email);
  push(BOOKING_FORM_FIELD_IDS.straat_huisnummer, values.straat_huisnummer);
  push(BOOKING_FORM_FIELD_IDS.postcode, values.postcode);
  push(BOOKING_FORM_FIELD_IDS.woonplaats, values.woonplaats);
  push(BOOKING_FORM_FIELD_IDS.tijdslot, values.tijdslot);
  push(BOOKING_FORM_FIELD_IDS.type_onderhoud, values.type_onderhoud);
  push(BOOKING_FORM_FIELD_IDS.probleemomschrijving, values.probleemomschrijving);
  push(BOOKING_FORM_FIELD_IDS.prijs_regels, values.prijs_regels);
  push(BOOKING_FORM_FIELD_IDS.betaal_status, values.betaal_status);
  push(BOOKING_FORM_FIELD_IDS.boekingsvoorstel_optie_1, values.boekingsvoorstel_optie_1);
  push(BOOKING_FORM_FIELD_IDS.boekingsvoorstel_optie_2, values.boekingsvoorstel_optie_2);
  push(BOOKING_FORM_FIELD_IDS.boekingsvoorstel_status, values.boekingsvoorstel_status);
  push(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum, values.boeking_bevestigd_datum);
  push(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_dagdeel, values.boeking_bevestigd_dagdeel);
  push(BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status, values.boeking_bevestigd_status);
  if (values.prijs_totaal !== undefined && values.prijs_totaal !== null && values.prijs_totaal !== '') {
    const n = toPriceNumber(values.prijs_totaal);
    if (n !== null) {
      out.push({
        id: BOOKING_FORM_FIELD_IDS.prijs_totaal,
        value: String(n),
        field_value: String(n),
      });
    }
  }

  for (const key of Object.keys(values)) {
    if (values[key] === undefined || values[key] === null || values[key] === '') continue;
    written[key] = key === 'prijs_totaal' ? toPriceNumber(values[key]) : normalizeText(values[key]);
  }
  return { customFields: out, written };
}
