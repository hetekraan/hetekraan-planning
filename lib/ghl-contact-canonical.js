/**
 * Canonieke GHL-contactvelden voor e-mail + adres (dashboard, Maps, boeking, WhatsApp-cron).
 * Nieuwe writes: altijd deze mapping; reads: samengestelde regel met fallback op legacy address1.
 *
 * **E-mail (canoniek):** top-level `email` op contact PUT/POST — geen apart adres-CF voor e-mail.
 * **Adres (canoniek):** native `address1`, `postalCode`, `city` + custom fields in `GHL_ADDR_CF_IDS`
 * (`buildCanonicalAddressWritePayload` / `readCanonicalAddressLine`).
 */

/** Zelfde normalisatie voor elke route die GHL `email` schrijft of vergelijkt. */
export function normalizeCanonicalGhlEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export const GHL_ADDR_CF_IDS = {
  straatnaam: 'ZwIMY4VPelG5rKROb5NR',
  huisnummer: 'co5Mr16rF6S6ay5hJOSJ',
  postcode: '3bCi5hL0rR9XGG33x2Gv',
  woonplaats: 'mFRQjlUppycMfyjENKF9',
};

/** GHL kan per response `id` of `fieldId` als custom-field-definitie-id teruggeven. */
export function getCfValue(contact, fieldId) {
  const fid = String(fieldId || '');
  const fields = contact?.customFields;
  if (!fid || !Array.isArray(fields)) return '';
  for (const f of fields) {
    const matchId = f?.id === fid || f?.fieldId === fid || f?.customFieldId === fid;
    if (matchId) {
      const raw = f.value ?? f.field_value;
      return raw != null && raw !== '' ? String(raw).trim() : '';
    }
  }
  return '';
}

/**
 * Eén adresregel voor dashboard / Google Maps (zelfde bron als volgorde: CF → anders address1).
 */
export function readCanonicalAddressLine(contact) {
  if (!contact) return '';
  const straat = getCfValue(contact, GHL_ADDR_CF_IDS.straatnaam);
  const huis = getCfValue(contact, GHL_ADDR_CF_IDS.huisnummer);
  const pc =
    getCfValue(contact, GHL_ADDR_CF_IDS.postcode) ||
    String(contact.postalCode || '')
      .replace(/\s+/g, ' ')
      .trim();
  const plaats =
    getCfValue(contact, GHL_ADDR_CF_IDS.woonplaats) || String(contact.city || '').trim();
  const fromCf = [straat, huis, pc, plaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const a1 = String(contact.address1 || '').replace(/\s+/g, ' ').trim();
  return fromCf || a1 || '';
}

/**
 * Zet GHL top-level `postalCode` + `city` (standaard contactkolommen) gelijk aan canonieke CF-waarden.
 */
export function mergeGhlNativeAddressFromParts(putPayload, parts) {
  if (!putPayload || !parts) return;
  const pc = String(parts.postcode ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const city = String(parts.woonplaats ?? '').trim();
  if (pc) putPayload.postalCode = pc;
  if (city) putPayload.city = city;
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
 * Eén regel → vier onderdelen (NL-postcode herkennen; rest voor straat+huis vóór postcode).
 * Zelfde onderverdeling als bedoeld voor CF naast address1 (cf. daily-analysis).
 */
export function parseSingleLineAddressToParts(line) {
  const normalized = String(line || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { straatnaam: '', huisnummer: '', postcode: '', woonplaats: '' };

  const pcMatch = normalized.match(/\b(\d{4}\s*[A-Za-z]{2})\b/i);
  let postcode = '';
  let streetPart = normalized;
  let woonplaats = '';

  if (pcMatch) {
    const raw = pcMatch[1].replace(/\s/g, '');
    if (raw.length >= 6) {
      postcode = `${raw.slice(0, 4)} ${raw.slice(4, 6).toUpperCase()}`;
    }
    streetPart = normalized.slice(0, pcMatch.index).replace(/[,\s]+$/g, '').trim();
    woonplaats = normalized.slice(pcMatch.index + pcMatch[0].length).replace(/^[,\s]+/g, '').trim();
  }

  const { straatnaam, huisnummer } = splitAddressLineToStraatHuis(streetPart);
  return {
    straatnaam: straatnaam || streetPart,
    huisnummer,
    postcode,
    woonplaats,
  };
}

/**
 * Zelfde schrijfpatroon als WhatsApp-extractie (daily-analysis):
 * - address1 = join(straat, huis, postcode, woonplaats) met niet-lege delen, anders genormaliseerde invoerregel
 * - customFields: per veld alleen meesturen als waarde niet leeg (zoals daily-analysis `saveToContact`)
 *
 * Boeking met één regel: `parseSingleLineAddressToParts` vult postcode/woonplaats waar mogelijk (NL-postcode in regel).
 *
 * `extra.*` overschrijft geparste waarden per veld.
 * @returns {{ address1: string, customFields: { id: string, field_value: string }[] }}
 */
export function buildCanonicalAddressWritePayload(fullLine, extra = {}) {
  const normalized = String(fullLine || '').replace(/\s+/g, ' ').trim();
  const parsed = parseSingleLineAddressToParts(normalized);

  const straatnaam =
    extra.straatnaam !== undefined && extra.straatnaam !== null
      ? String(extra.straatnaam).trim()
      : parsed.straatnaam;
  const huisnummer =
    extra.huisnummer !== undefined && extra.huisnummer !== null
      ? String(extra.huisnummer).trim()
      : parsed.huisnummer;
  const postcode =
    extra.postcode !== undefined && extra.postcode !== null
      ? String(extra.postcode).trim()
      : parsed.postcode;
  const woonplaats =
    extra.woonplaats !== undefined && extra.woonplaats !== null
      ? String(extra.woonplaats).trim()
      : parsed.woonplaats;

  let address1 = [straatnaam, huisnummer, postcode, woonplaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!address1) address1 = normalized;

  const customFields = [];
  const add = (id, v) => {
    const s = String(v ?? '').trim();
    // Webhook-schema gebruikt `value`; oudere voorbeelden gebruiken `field_value` — beide meesturen.
    if (s) customFields.push({ id, value: s, field_value: s });
  };
  if (!customFields.length && normalized) {
    customFields.push({
      id: GHL_ADDR_CF_IDS.straatnaam,
      value: normalized,
      field_value: normalized,
    });
  }

  return {
    address1,
    customFields,
    parts: { straatnaam, huisnummer, postcode, woonplaats },
  };
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
