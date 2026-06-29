// lib/invite-slot-context.js
// Eén bron van waarheid voor workType + adres in de tijdslot-flow.
// Zowel api/suggest-slots.js (genereren) als api/send-booking-invite.js (valideren)
// gebruiken deze resolvers, zodat een voorgesteld slot niet "verdwijnt" bij versturen
// door een verschillende workType/adres-interpretatie (split-brain).

import { normalizeWorkType } from './booking-blocks.js';
import { readCanonicalAddressLine } from './ghl-contact-canonical.js';

/**
 * Bepaal het effectieve workType voor de tijdslot-flow.
 *
 * Bron-volgorde (consistent in beide paden):
 *   1. Formulier (workTypeParam → typeParam) — wat de planner expliciet koos voor DEZE uitnodiging.
 *   2. GHL contact `type_onderhoud` (fallback als het formulier niets meestuurt, bv. API zonder UI).
 *   3. `normalizeWorkType('')` → 'reparatie' (laatste fallback; nooit stil 'onderhoud').
 *
 * Belangrijk: we kijken naar de RUWE (getrimde) string vóór normalisatie om te beslissen
 * welke bron wint, omdat normalizeWorkType('') nooit leeg teruggeeft ('reparatie').
 *
 * @param {{ typeParam?: unknown, workTypeParam?: unknown, contactTypeField?: unknown }} input
 * @returns {string} genormaliseerd workType
 */
export function resolveInviteWorkType({ typeParam, workTypeParam, contactTypeField } = {}) {
  const form = String(workTypeParam ?? typeParam ?? '').trim();
  if (form) return normalizeWorkType(form);
  const ghl = String(contactTypeField ?? '').trim();
  if (ghl) return normalizeWorkType(ghl);
  return normalizeWorkType('');
}

/**
 * Bepaal het effectieve adres voor geo-check + capaciteit.
 *
 * Bron-volgorde (zelfde principe als telefoon: formulier wint, GHL fallback):
 *   1. Formulier `addressParam`.
 *   2. Canonieke GHL-adresregel (readCanonicalAddressLine).
 *   3. `contact.address1`.
 *
 * @param {{ addressParam?: unknown, contact?: object|null }} input
 * @returns {string} adresregel (kan leeg zijn als nergens bekend)
 */
export function resolveInviteAddress({ addressParam, contact } = {}) {
  const form = String(addressParam ?? '').trim();
  if (form) return form;
  const canon = String(readCanonicalAddressLine(contact) || '').trim();
  if (canon) return canon;
  return String(contact?.address1 ?? '').trim();
}
