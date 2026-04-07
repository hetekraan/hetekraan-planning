/**
 * Canoniek dashboard-model: één Appointment per kalenderrij (klant of blok).
 * Mapping van enriched GHL-event (zoals getAppointments die achter enrichEvent achterlaat).
 */

import {
  SLOT_LABEL_AFTERNOON_NL,
  SLOT_LABEL_MORNING_NL,
} from '../planning-work-hours.js';
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
  const rawStartMs = eventStartMsGhl(e);
  /** Geen Date.now(): ontbrekende/ongeldige GHL-start zou anders als “vandaag” in tijd/sortering verschijnen. */
  let normalizedStartMs = rawStartMs;
  if (Number.isNaN(rawStartMs)) normalizedStartMs = 0;

  const start = new Date(normalizedStartMs);
  const dayPart = isCalBlock
    ? 0
    : Number.isNaN(rawStartMs)
      ? 0
      : hourInAmsterdamFromMs(rawStartMs) < 13
        ? 0
        : 1;

  const titleFallback = e.title || 'Werkzaamheden';
  const timeSlot =
    isCalBlock && normalizedStartMs === 0
      ? '—'
      : !isCalBlock && Number.isNaN(rawStartMs)
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
  let workLine = e.parsedWork || titleFallback;
  if (e._hkBlockReservationSynthetic && String(titleFallback).includes('__hk_block_res__')) {
    const pw = String(e.parsedWork || '');
    if (!e.parsedWork || pw.includes('__hk_block_res__')) {
      const blk = e._hkSyntheticBlock === 'afternoon' ? 'afternoon' : 'morning';
      const windowLabel =
        blk === 'afternoon' ? SLOT_LABEL_AFTERNOON_NL : SLOT_LABEL_MORNING_NL;
      workLine = `Online geboekt — ${blk === 'morning' ? 'ochtend' : 'middag'} (${windowLabel})`;
    } else {
      workLine = e.parsedWork;
    }
  }
  const canonicalJobType = String(e.parsedJobType || '').trim().toLowerCase();
  const jobType = isCalBlock
    ? 'onderhoud'
    : (canonicalJobType || inferDashboardJobTypeFromWorkText(workLine));
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
    /** Model B1: Redis block-capacity rij zonder GHL timed appointment. */
    isSyntheticBlockBooking: Boolean(e._hkBlockReservationSynthetic),
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
    startMs: normalizedStartMs,
    dayPart,
    isCalBlock,
    blockEndLabel,
    timeWindow: e.parsedTimeWindow || null,
    paymentStatus: e.parsedPaymentStatus || '',
    firstName,
    lastName,
    price:
      Array.isArray(e.parsedExtras) && e.parsedExtras.length > 0
        ? 0
        : parseFloat(String(priceRaw).replace(/[^0-9.]/g, '')) || 0,
    priceLabel: priceRaw ? `€${priceRaw}` : '',
    extras: Array.isArray(e.parsedExtras)
      ? e.parsedExtras.map((r) => {
          const p = Number(r?.price);
          return {
            desc: String(r?.desc ?? '').trim(),
            price: Number.isFinite(p) ? Math.round(p * 100) / 100 : 0,
          };
        })
      : [],
    datumInstallatie:
      contact.customFields?.find((f) => f.id === CF_DATUM_INSTALLATIE)?.value || '',
    datumOnderhoud:
      contact.customFields?.find((f) => f.id === CF_DATUM_ONDERHOUD)?.value || '',
  };
}
