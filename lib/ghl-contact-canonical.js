/**
 * Canonieke GHL-contactvelden voor e-mail + adres (dashboard, Maps, boeking, WhatsApp-cron).
 * Nieuwe writes: altijd deze mapping; reads: samengestelde regel met fallback op legacy address1.
 */

export const GHL_ADDR_CF_IDS = {
  straatnaam: 'ZwIMY4VPelG5rKROb5NR',
  huisnummer: 'co5Mr16rF6S6ay5hJOSJ',
  postcode: '3bCi5hL0rR9XGG33x2Gv',
  woonplaats: 'mFRQjlUppycMfyjENKF9',
};

export function getCfValue(contact, fieldId) {
  return contact?.customFields?.find((f) => f.id === fieldId)?.value || '';
}

/**
 * Eén adresregel voor dashboard / Google Maps (zelfde bron als volgorde: CF → anders address1).
 */
export function readCanonicalAddressLine(contact) {
  if (!contact) return '';
  const straat = getCfValue(contact, GHL_ADDR_CF_IDS.straatnaam);
  const huis = getCfValue(contact, GHL_ADDR_CF_IDS.huisnummer);
  const pc = getCfValue(contact, GHL_ADDR_CF_IDS.postcode);
  const plaats = getCfValue(contact, GHL_ADDR_CF_IDS.woonplaats) || String(contact.city || '').trim();
  const fromCf = [straat, huis, pc, plaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const a1 = String(contact.address1 || '').replace(/\s+/g, ' ').trim();
  return fromCf || a1 || '';
}

/**
 * Splits één regel in straat + huisnummer (eerste token dat met cijfer begint = huisnr).
 */
export function splitAddressLineToStraatHuis(fullLine) {
  const normalized = String(fullLine || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { straatnaam: '', huisnummer: '' };
  const parts = normalized.split(' ').filter(Boolean);
  const numIdx = parts.findIndex((p) => /^\d/.test(p));
  const huisnummer = numIdx >= 0 ? parts[numIdx] : '';
  const straatnaam = numIdx >= 0 ? parts.slice(0, numIdx).join(' ') : normalized;
  return { straatnaam: straatnaam || normalized, huisnummer };
}

/**
 * Voor GHL PUT: address1 + custom fields straat/huis (+ postcode/plaats als bekend).
 * `extra.straatnaam` / `huisnummer` (bijv. WhatsApp-extractie) hebben voorrang boven split van fullLine.
 * @returns {{ address1: string, customFields: { id: string, field_value: string }[] }}
 */
export function buildCanonicalAddressWritePayload(fullLine, extra = {}) {
  let address1 = String(fullLine || '').replace(/\s+/g, ' ').trim();
  let straatnaam = extra.straatnaam != null ? String(extra.straatnaam).trim() : '';
  let huisnummer = extra.huisnummer != null ? String(extra.huisnummer).trim() : '';
  const postcode = extra.postcode != null ? String(extra.postcode).trim() : '';
  const woonplaats = extra.woonplaats != null ? String(extra.woonplaats).trim() : '';

  if (!straatnaam && !huisnummer && address1) {
    const s = splitAddressLineToStraatHuis(address1);
    straatnaam = s.straatnaam;
    huisnummer = s.huisnummer;
  } else if (straatnaam && !huisnummer && address1) {
    const s = splitAddressLineToStraatHuis(address1);
    huisnummer = s.huisnummer;
  }

  if (!address1) {
    address1 = [straatnaam, huisnummer, postcode, woonplaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  const customFields = [
    { id: GHL_ADDR_CF_IDS.straatnaam, field_value: straatnaam || address1 },
    { id: GHL_ADDR_CF_IDS.huisnummer, field_value: huisnummer },
  ];
  if (postcode) customFields.push({ id: GHL_ADDR_CF_IDS.postcode, field_value: postcode });
  if (woonplaats) customFields.push({ id: GHL_ADDR_CF_IDS.woonplaats, field_value: woonplaats });
  return { address1, customFields };
}

const DBG = '[GHLL_CANON_CONTACT]';

export function logCanonicalAddressWrite(source, detail) {
  console.log(`${DBG} write path=${source}`, detail);
}

export function logCanonicalAddressRead(source, detail) {
  console.log(`${DBG} read path=${source}`, detail);
}

/** GHL-contact: primair veld `email` (top-level). */
export function logCanonicalEmailWrite(source, detail) {
  console.log(`${DBG} email write path=${source}`, detail);
}
