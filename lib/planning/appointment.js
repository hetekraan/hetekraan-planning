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

/** `datum_laatste_onderhoud` (CF) equals route day → monteur heeft op die route-dag afgerond. */
export function plannerServiceMarkedCompleteOnRouteDay(datumOnderhoudFieldValue, routeYmd) {
  if (!routeYmd || datumOnderhoudFieldValue == null || datumOnderhoudFieldValue === '') return false;
  const v = String(datumOnderhoudFieldValue).trim();
  const r = String(routeYmd).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r)) return false;
  if (v === r) return true;
  if (v.startsWith(`${r}T`) || v.startsWith(`${r} `)) return true;
  return false;
}

function normalizeTimeStr(t) {
  if (t == null || t === '') return '';
  const s = String(t).replace(/^~/, '').trim();
  const parts = s.split(':');
  const h = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
  const m = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeYmdFromValue(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  const m = v.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function dayPartFromTimeWindowLabel(timeWindow) {
  const s = String(timeWindow || '').toLowerCase();
  if (!s) return null;
  if (s.includes('13:00–17:00') || s.includes('13:00-17:00') || s.includes('middag')) return 1;
  if (s.includes('09:00–13:00') || s.includes('09:00-13:00') || s.includes('ochtend')) return 0;
  return null;
}

/**
 * @param {object} e — enriched GHL event (parsed* + contact)
 * @param {number} rowFallbackIndex — alleen als er geen canoniek event-id is
 * @param {string} [viewedRouteDateStr] — YYYY-MM-DD van de planner-dag (voor klaar-status via datum_laatste_onderhoud)
 */
export function mapEnrichedGhlEventToAppointment(e, rowFallbackIndex = 0, viewedRouteDateStr = '') {
  const isCalBlock = !!e._hkGhlBlockSlot;
  const rawStartMs = eventStartMsGhl(e);
  /** Geen Date.now(): ontbrekende/ongeldige GHL-start zou anders als “vandaag” in tijd/sortering verschijnen. */
  let normalizedStartMs = rawStartMs;
  if (Number.isNaN(rawStartMs)) normalizedStartMs = 0;

  const start = new Date(normalizedStartMs);
  const eventYmd =
    normalizeYmdFromValue(viewedRouteDateStr) ||
    normalizeYmdFromValue(e.date) ||
    normalizeYmdFromValue(e.dateStr);
  const confirmedDate = normalizeYmdFromValue(e.parsedConfirmedDate);
  const confirmedDayPart =
    e.parsedConfirmedDayPart === 'afternoon'
      ? 1
      : e.parsedConfirmedDayPart === 'morning'
        ? 0
        : null;
  const confirmedDayPartMatched =
    confirmedDayPart !== null &&
    confirmedDate &&
    eventYmd &&
    confirmedDate === eventYmd;
  /** Harde klant-lock: alleen na expliciete confirm (custom field status). */
  const bookingLocked =
    !isCalBlock &&
    confirmedDayPartMatched &&
    e.parsedConfirmedStatus === 'confirmed';
  const syntheticDayPart =
    e._hkSyntheticBlock === 'afternoon' ? 1 : e._hkSyntheticBlock === 'morning' ? 0 : null;
  const timeWindowDayPart = dayPartFromTimeWindowLabel(e.parsedTimeWindow);
  const inferredEventTimeDayPart = isCalBlock
    ? 0
    : Number.isNaN(rawStartMs)
      ? 0
      : hourInAmsterdamFromMs(rawStartMs) < 13
        ? 0
        : 1;
  const dayPart = confirmedDayPartMatched
    ? confirmedDayPart
    : syntheticDayPart !== null
      ? syntheticDayPart
      : timeWindowDayPart !== null
        ? timeWindowDayPart
        : inferredEventTimeDayPart;

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
  const rawPin = e.internalFixedPin ?? e.internalFixedStartTime ?? '';
  let internalFixedPin = null;
  try {
    if (rawPin && typeof rawPin === 'object') {
      internalFixedPin = rawPin;
    } else {
      const pinStr = String(rawPin || '').trim();
      internalFixedPin = pinStr.startsWith('{')
        ? JSON.parse(pinStr)
        : pinStr
          ? { type: 'exact', time: pinStr }
          : null;
    }
    if (internalFixedPin) {
      const type = String(internalFixedPin.type || '').trim().toLowerCase();
      const time = normalizeTimeStr(String(internalFixedPin.time || '').replace(/^~/, ''));
      internalFixedPin =
        (type === 'exact' || type === 'after' || type === 'before') && /^\d{2}:\d{2}$/.test(time)
          ? { type, time }
          : null;
    }
  } catch {
    internalFixedPin = null;
  }

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
    : `${firstName} ${lastName}`.trim() || String(contact.name || '').trim() || String(e.title || '').trim() || 'Klant';

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

  const datumInstallatieVal =
    contact.customFields?.find((f) => f.id === CF_DATUM_INSTALLATIE)?.value || '';
  const datumOnderhoudVal =
    contact.customFields?.find((f) => f.id === CF_DATUM_ONDERHOUD)?.value || '';

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

  const extrasArr = Array.isArray(e.parsedExtras)
    ? e.parsedExtras.map((r) => {
        const p = Number(r?.price);
        return {
          desc: String(r?.desc ?? '').trim(),
          price: Number.isFinite(p) ? Math.round(p * 100) / 100 : 0,
        };
      })
    : [];
  const extrasSum = extrasArr.reduce((s, r) => s + (Number.isFinite(r.price) ? r.price : 0), 0);
  const totalCanon = parseFloat(String(priceRaw).replace(/[^0-9.]/g, ''));
  const hasValidTotal = Number.isFinite(totalCanon) && totalCanon >= 0;
  /** `boekingsformulier_prijs_totaal` = volledig totaal; regels kunnen alleen extra’s zijn → basis = totaal − som(regels). */
  let price = 0;
  if (extrasArr.length === 0) {
    price = hasValidTotal ? totalCanon : 0;
  } else if (hasValidTotal && totalCanon + 1e-6 >= extrasSum) {
    price = Math.max(0, Math.round((totalCanon - extrasSum) * 100) / 100);
  } else {
    price = 0;
  }

  let status = 'ingepland';
  if (!isCalBlock && viewedRouteDateStr && plannerServiceMarkedCompleteOnRouteDay(datumOnderhoudVal, viewedRouteDateStr)) {
    status = 'klaar';
  }

  /** Klant-slot (extern contract): vaste vensters; overschrijf legacy vrije tekst zodat optimizer/route nooit “terug infereren” via verkeerde GHL-start. */
  let timeWindowOut = e.parsedTimeWindow || null;
  if (confirmedDayPartMatched) {
    timeWindowOut = confirmedDayPart === 1 ? SLOT_LABEL_AFTERNOON_NL : SLOT_LABEL_MORNING_NL;
  }

  const lockedBlock = bookingLocked ? (confirmedDayPart === 1 ? 'afternoon' : 'morning') : null;

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
    woonplaats: city,
    phone: contact.phone || '',
    email: String(contact.email || '').trim().toLowerCase(),
    jobType,
    timeSlot,
    internalFixedPin,
    internalFixedStartTime: internalFixedPin?.time || '',
    status,
    notes,
    mapsLink,
    jobDescription,
    fullAddressLine,
    contactId: cid,
    startMs: normalizedStartMs,
    dayPart,
    isCalBlock,
    blockEndLabel,
    timeWindow: timeWindowOut,
    /** Harde boekings-lock (datum + blok) — alleen true na confirm-status + datum-match. */
    bookingLocked: Boolean(bookingLocked),
    lockedDate: bookingLocked ? confirmedDate : null,
    lockedBlock,
    paymentStatus: e.parsedPaymentStatus || '',
    firstName,
    lastName,
    price,
    priceLabel: priceRaw ? `€${priceRaw}` : '',
    extras: extrasArr,
    datumInstallatie: datumInstallatieVal,
    datumOnderhoud: datumOnderhoudVal,
  };
}
