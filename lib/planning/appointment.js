/**
 * Canoniek dashboard-model: één Appointment per kalenderrij (klant of blok).
 * Mapping van enriched GHL-event (zoals getAppointments die achter enrichEvent achterlaat).
 */

import {
  canonicalGhlEventId,
  eventEndMsGhl,
  eventStartMsGhl,
} from './ghl-event-core.js';

/** Zelfde custom field IDs als api/ghl.js (dashboard / completeAppointment). */
const CF_DATUM_INSTALLATIE = 'kYP2SCmhZ21Ig0aaLl5l';
const CF_DATUM_ONDERHOUD = 'hiTe3Yi5TlxheJq4bLzy';

export function mapsSearchUrlFromAddressLine(line) {
  const q = String(line || '').trim();
  if (!q) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Zelfde heuristiek als het vroegere dashboard (titel / werktekst). */
export function inferDashboardJobTypeFromWorkText(work) {
  const w = String(work || '');
  let t = 'onderhoud';
  if (/instal|plaatsen|nieuw|monter/i.test(w)) t = 'installatie';
  if (/repar|lek|storing|kijken|nazorg|vervang/i.test(w)) t = 'reparatie';
  return t;
}

function hourInAmsterdamFromMs(ms) {
  return parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(ms)),
    10
  );
}

function normalizeTimeStr(t) {
  if (t == null || t === '') return '';
  const s = String(t).replace(/^~/, '').trim();
  const parts = s.split(':');
  const h = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
  const m = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * @param {object} e — enriched GHL event (parsed* + contact)
 * @param {number} rowFallbackIndex — alleen als er geen canoniek event-id is
 */
export function mapEnrichedGhlEventToAppointment(e, rowFallbackIndex = 0) {
  const isCalBlock = !!e._hkGhlBlockSlot;
  let startMs = eventStartMsGhl(e);
  if (isCalBlock && Number.isNaN(startMs)) startMs = 0;
  const start = new Date(Number.isNaN(startMs) ? Date.now() : startMs);
  const dayPart = isCalBlock ? 0 : hourInAmsterdamFromMs(startMs) < 13 ? 0 : 1;

  const titleFallback = e.title || 'Werkzaamheden';
  const timeSlot =
    isCalBlock && startMs === 0
      ? '—'
      : normalizeTimeStr(
          start.toLocaleTimeString('nl-NL', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Amsterdam',
          })
        );

  const straat = e.parsedStraatnaam || '';
  const huisnr = e.parsedHuisnummer || '';
  const postalCode = e.parsedPostcode || '';
  const city = e.parsedWoonplaats || '';
  const address = [straat, huisnr].filter(Boolean).join(' ').trim();
  const fullAddressLine = [straat, huisnr, postalCode, city].filter(Boolean).join(' ');

  const contact = e.contact || {};
  const firstName = contact.firstName || '';
  const lastName = contact.lastName || '';
  const name = isCalBlock
    ? (titleFallback || 'Agenda geblokkeerd')
    : `${firstName} ${lastName}`.trim() || fullAddressLine.split(' ')[0] || 'Klant';

  const cid = String(e.contactId || e.contact_id || contact.id || '').trim();
  const workLine = e.parsedWork || titleFallback;
  const jobType = isCalBlock ? 'onderhoud' : inferDashboardJobTypeFromWorkText(workLine);
  const jobDescription = isCalBlock ? titleFallback : workLine;
  const notes = e.parsedNotes || '';

  const priceRaw = e.parsedPrice || '';
  const mapsLink = mapsSearchUrlFromAddressLine(fullAddressLine);

  let id = canonicalGhlEventId(e);
  if (!id) id = `row-${rowFallbackIndex}`;

  let blockEndLabel = '';
  const endMsRaw = eventEndMsGhl(e);
  if (isCalBlock && !Number.isNaN(endMsRaw)) {
    blockEndLabel = normalizeTimeStr(
      new Date(endMsRaw).toLocaleTimeString('nl-NL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Amsterdam',
      })
    );
  }

  return {
    id,
    name,
    address,
    straatnaam: straat,
    huisnummer: huisnr,
    postalCode,
    city,
    phone: contact.phone || '',
    jobType,
    timeSlot,
    status: 'ingepland',
    notes,
    mapsLink,
    jobDescription,
    fullAddressLine,
    contactId: cid,
    startMs,
    dayPart,
    isCalBlock,
    blockEndLabel,
    timeWindow: e.parsedTimeWindow || null,
    firstName,
    lastName,
    price:
      Array.isArray(e.parsedExtras) && e.parsedExtras.length > 0
        ? 0
        : parseFloat(String(priceRaw).replace(/[^0-9.]/g, '')) || 0,
    priceLabel: priceRaw ? `€${priceRaw}` : '',
    extras: Array.isArray(e.parsedExtras)
      ? e.parsedExtras.map((r) => ({ desc: r.desc, price: Number(r.price) || 0 }))
      : [],
    datumInstallatie:
      contact.customFields?.find((f) => f.id === CF_DATUM_INSTALLATIE)?.value || '',
    datumOnderhoud:
      contact.customFields?.find((f) => f.id === CF_DATUM_ONDERHOUD)?.value || '',
  };
}
