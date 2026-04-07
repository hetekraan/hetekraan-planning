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

function formatPriceNumber(value) {
  if (value === undefined || value === null || value === '') return '';
  const n = Number(value);
  if (Number.isFinite(n)) return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return normalizeText(value);
}

export function formatPriceRulesStructuredString(priceRules) {
  if (!priceRules) return '';
  let rows = priceRules;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      return normalizeText(rows);
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const lines = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const label = normalizeText(
      row.label ?? row.desc ?? row.omschrijving ?? row.name ?? row.title ?? ''
    );
    const amount = formatPriceNumber(row.amount ?? row.price ?? row.value ?? '');
    if (!label && !amount) continue;
    lines.push(`${label || 'regel'}|${amount}`);
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
