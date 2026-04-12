import { formatYyyyMmDdInAmsterdam } from '../amsterdam-calendar-day.js';
import {
  appendBookingCanonFields,
  formatPriceRulesStructuredString,
  normalizePriceLineItems,
  toPriceNumber,
} from '../booking-canon-fields.js';

export const LEGACY_COMPLETE_FIELD_IDS = {
  datum_laatste_onderhoud: 'hiTe3Yi5TlxheJq4bLzy',
  legacy_betalingsstatus: 'xAg0jUYsOL6IZZjdHuRq',
  datum_installatie: 'kYP2SCmhZ21Ig0aaLl5l',
  legacy_prijs: 'HGjlT6ofaBiMz3j2HsXL',
  legacy_prijs_regels: 'gPjrUG2eH81PeALh8tVS',
};

export function buildCompleteAppointmentPayload({
  routeDate,
  type,
  totalPrice,
  extras,
  /** YYYY-MM-DD van laatste onderhoud; leeg = zelfde als route-/servicedag */
  lastService,
} = {}) {
  const today = formatYyyyMmDdInAmsterdam(new Date()) || new Date().toISOString().split('T')[0];
  const serviceDay = normalizeYyyyMmDdInput(String(routeDate || '').trim()) || today;
  const lastMaintNorm = normalizeYyyyMmDdInput(String(lastService || '').trim());
  const datumLaatsteOnderhoud = lastMaintNorm || serviceDay;
  const customFields = [
    { id: LEGACY_COMPLETE_FIELD_IDS.datum_laatste_onderhoud, field_value: datumLaatsteOnderhoud },
    { id: LEGACY_COMPLETE_FIELD_IDS.legacy_betalingsstatus, field_value: 'Afgerond' },
  ];
  if (type === 'installatie') {
    customFields.push({ id: LEGACY_COMPLETE_FIELD_IDS.datum_installatie, field_value: serviceDay });
  }
  if (totalPrice != null) {
    customFields.push({ id: LEGACY_COMPLETE_FIELD_IDS.legacy_prijs, field_value: String(totalPrice) });
  }

  const extrasNorm = normalizePriceLineItems(Array.isArray(extras) ? extras : []);
  if (extrasNorm.length > 0) {
    customFields.push({
      id: LEGACY_COMPLETE_FIELD_IDS.legacy_prijs_regels,
      field_value: JSON.stringify(extrasNorm),
    });
  }
  const canonicalPrijsRegels = formatPriceRulesStructuredString(extrasNorm);
  const canonicalPrijsTotaal = toPriceNumber(totalPrice);
  const bookingCanon = appendBookingCanonFields(customFields, {
    prijs_regels: canonicalPrijsRegels,
    prijs_totaal: canonicalPrijsTotaal,
    betaal_status: 'Afgerond',
  });
  return {
    serviceDay,
    datumLaatsteOnderhoud,
    extrasNorm,
    canonicalPrijsRegels,
    canonicalPrijsTotaal,
    customFields: bookingCanon.customFields,
  };
}

function normalizeYyyyMmDdInput(str) {
  if (!str || typeof str !== 'string') return null;
  const p = str.trim().split('-').map((x) => parseInt(x, 10));
  if (p.length !== 3 || p.some((n) => Number.isNaN(n))) return null;
  const [y, mo, d] = p;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
