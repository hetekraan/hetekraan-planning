// api/booking.js — slim boekingssysteem met route-optimalisatie
import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  amsterdamWeekdaySun0,
  formatYyyyMmDdInAmsterdam,
  hourInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import {
  blockAllowsNewCustomerBooking,
  ghlDurationMinutesForType,
  normalizeWorkType,
} from '../lib/booking-blocks.js';
import { fetchCalendarEventCountForDay, maxCustomerAppointmentsPerDay } from '../lib/calendar-customer-cap.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { fetchWithRetry } from '../lib/retry.js';
import { pulseContactTag } from '../lib/ghl-tag.js';
import {
  DAYPART_SPLIT_HOUR,
  SLOT_LABEL_AFTERNOON_NL,
  SLOT_LABEL_MORNING_NL,
  WORK_DAY_END_HOUR,
  WORK_DAY_START_HOUR,
} from '../lib/planning-work-hours.js';
import { ghlCalendarIdFromEnv } from '../lib/ghl-env-ids.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const GOOGLE_API_KEY  = process.env.GOOGLE_MAPS_API_KEY;

const DEPOT = 'Cornelis Dopperkade, Amsterdam';

function slotLabel(h) {
  const hours = Math.floor(h);
  const mins = Math.round((h % 1) * 60);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** Starttijden (uur als decimaal) binnen ochtend/middag-werktijden; afhankelijk van GHL-duur (60 of 90 min). */
function candidateStartHoursForBlock(block, durationMin) {
  const starts = [];
  const stepMin = 30;
  const mornEnd = DAYPART_SPLIT_HOUR * 60;
  const aftEnd = WORK_DAY_END_HOUR * 60;
  if (block === 'morning') {
    for (let m = WORK_DAY_START_HOUR * 60; m < mornEnd; m += stepMin) {
      if (m + durationMin <= mornEnd) starts.push(m / 60);
    }
  } else {
    for (let m = DAYPART_SPLIT_HOUR * 60; m < aftEnd; m += stepMin) {
      if (m + durationMin <= aftEnd) starts.push(m / 60);
    }
  }
  return starts;
}

function allCandidateHours(durationMin) {
  return [
    ...candidateStartHoursForBlock('morning', durationMin),
    ...candidateStartHoursForBlock('afternoon', durationMin),
  ];
}

function splitEventsByBlock(events) {
  const morning = [];
  const afternoon = [];
  for (const e of events) {
    const h = hourInAmsterdam(e.startTime);
    if (h < DAYPART_SPLIT_HOUR) morning.push(e);
    else afternoon.push(e);
  }
  return { morning, afternoon };
}

function eventIntervalMs(e) {
  const s = new Date(e.startTime).getTime();
  const endMs = e.endTime ? new Date(e.endTime).getTime() : s + 60 * 60000;
  return { startMs: s, endMs };
}

function rangesOverlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function bookingIntervalFitsCalendar(dateStr, startHourDec, durationMin, events) {
  const hh = Math.floor(startHourDec);
  const mm = Math.round((startHourDec % 1) * 60);
  const startD = amsterdamWallTimeToDate(dateStr, hh, mm);
  if (!startD) return null;
  const startMs = startD.getTime();
  const endMs = startMs + durationMin * 60000;
  for (const e of events) {
    const iv = eventIntervalMs(e);
    if (rangesOverlap(startMs, endMs, iv.startMs, iv.endMs)) return null;
  }
  return { startMs, endMs, startD };
}

function slotAvailableForWorkType(dateStr, events, workType, startHourDec) {
  const durationMin = ghlDurationMinutesForType(workType);
  const block = startHourDec < DAYPART_SPLIT_HOUR ? 'morning' : 'afternoon';
  const { morning, afternoon } = splitEventsByBlock(events);
  const blockEvents = block === 'morning' ? morning : afternoon;
  if (!blockAllowsNewCustomerBooking(block, blockEvents, workType)) return false;
  return bookingIntervalFitsCalendar(dateStr, startHourDec, durationMin, events) != null;
}

function computeSlotsForDay(dateStr, events, workType) {
  const durationMin = ghlDurationMinutesForType(workType);
  const hours = allCandidateHours(durationMin);
  const { morning, afternoon } = splitEventsByBlock(events);
  const morningOk = blockAllowsNewCustomerBooking('morning', morning, workType);
  const afternoonOk = blockAllowsNewCustomerBooking('afternoon', afternoon, workType);

  return hours.map((h) => {
    const block = h < DAYPART_SPLIT_HOUR ? 'morning' : 'afternoon';
    const blockOk = block === 'morning' ? morningOk : afternoonOk;
    const interval = blockOk ? bookingIntervalFitsCalendar(dateStr, h, durationMin, events) : null;
    const available = Boolean(interval);
    const endH = h + durationMin / 60;
    return {
      time: slotLabel(h),
      timeEnd: slotLabel(endH),
      hour: h,
      available,
    };
  });
}

// Custom field IDs
const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  postcode:            '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:          'mFRQjlUppycMfyjENKF9',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  tijdafspraak:        'RfKARymCOYYkufGY053T',
};

function formatDateLongNlForBooking(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return dateStr || '';
  const utc = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Date(utc).toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Amsterdam',
  });
}

async function getAppointmentsForDay(dateStr) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return [];
  const { startMs, endMs } = bounds;
  const url = `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(GHL_LOCATION_ID)}&calendarId=${encodeURIComponent(ghlCalendarIdFromEnv())}&startTime=${startMs}&endTime=${endMs}`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const data = await res.json();
    return data?.events || [];
  } catch (_) { return []; }
}

// Haalt adres op uit GHL contact custom fields
async function getContactAddress(contactId) {
  if (!contactId) return '';
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const data = await res.json();
    const contact = data?.contact || data;
    const cf = contact?.customFields || [];
    const get = id => cf.find(f => f.id === id)?.value || '';
    const parts = [get(FIELD_IDS.straatnaam), get(FIELD_IDS.huisnummer), get(FIELD_IDS.postcode), get(FIELD_IDS.woonplaats) || contact?.city || ''];
    return parts.filter(Boolean).join(' ');
  } catch (_) { return ''; }
}

// Berekent reisafstand van nieuw adres naar dichtstbijzijnde bestaande afspraak
async function nearestDistanceMeters(existingAddresses, newAddress) {
  if (!GOOGLE_API_KEY || existingAddresses.length === 0) return null;
  try {
    const origins = encodeURIComponent(newAddress);
    const dests = existingAddresses.slice(0, 10).map(a => encodeURIComponent(a)).join('|');
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${dests}&key=${GOOGLE_API_KEY}&language=nl&units=metric`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') return null;
    const elements = data.rows[0]?.elements || [];
    const valid = elements.filter(e => e.status === 'OK').map(e => e.distance?.value || 999999);
    return valid.length ? Math.min(...valid) : null;
  } catch (_) { return null; }
}

// Zoek of maak contact aan in GHL
async function findOrCreateContact({ firstName, lastName, phone, email, address, workType, description }) {
  // Zoek op telefoonnummer
  try {
    const searchRes = await fetch(`${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(phone)}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const searchData = await searchRes.json();
    const existing = searchData?.contacts?.[0];
    if (existing) return existing.id;
  } catch (_) {}

  // Adres parsen voor custom fields
  const parts = (address || '').split(' ');
  const pcIdx = parts.findIndex(p => /^\d{4}[A-Za-z]{2}$/.test(p));
  const straat = parts.slice(0, Math.max(0, pcIdx - 1)).join(' ');
  const huisnr = pcIdx > 0 ? parts[pcIdx - 1] : '';
  const postcode = pcIdx >= 0 ? parts[pcIdx].toUpperCase() : '';
  const woonplaats = pcIdx >= 0 ? parts.slice(pcIdx + 1).join(' ') : '';

  const customFields = [
    { id: FIELD_IDS.type_onderhoud,       field_value: workType || '' },
    { id: FIELD_IDS.probleemomschrijving, field_value: description || '' },
    ...(address ? [
      { id: FIELD_IDS.straatnaam,  field_value: straat },
      { id: FIELD_IDS.huisnummer,  field_value: huisnr },
      { id: FIELD_IDS.postcode,    field_value: postcode },
      { id: FIELD_IDS.woonplaats,  field_value: woonplaats },
    ] : [])
  ].filter(f => f.field_value);

  const phoneNorm = normalizeNlPhone(String(phone || '').replace(/\s/g, '')) || phone;

  const createRes = await fetch(`${GHL_BASE}/contacts/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      firstName,
      lastName: lastName || '',
      phone: phoneNorm,
      email: email || '',
      address1: address || '',
      customFields,
    }),
  });
  const createData = await createRes.json();
  return createData?.contact?.id || createData?.id || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'GET' ? req.query : req.body;
  const { action } = params;

  try {
    switch (action) {

      // Geeft beschikbare dagen terug (volgende 14 werkdagen)
      case 'getDays': {
        const workType = normalizeWorkType(params.workType);
        const days = [];
        let dateStr = addAmsterdamCalendarDays(formatYyyyMmDdInAmsterdam(new Date()), 1);
        if (!dateStr) return res.status(500).json({ error: 'Datumfout' });

        const dayPromises = [];
        const dayMeta = [];

        for (let guard = 0; guard < 40 && dayMeta.length < 14; guard++) {
          const dow = amsterdamWeekdaySun0(dateStr);
          if (dow == null) break;
          if (dow === 0 || dow === 6) {
            dateStr = addAmsterdamCalendarDays(dateStr, 1);
            continue;
          }
          dayMeta.push({ dateStr });
          dayPromises.push(getAppointmentsForDay(dateStr));
          dateStr = addAmsterdamCalendarDays(dateStr, 1);
        }

        const results = await Promise.all(dayPromises);

        for (let i = 0; i < dayMeta.length; i++) {
          const { dateStr } = dayMeta[i];
          const bounds = amsterdamCalendarDayBoundsMs(dateStr);
          if (!bounds) continue;
          const noon = new Date(bounds.startMs + 12 * 3600000);
          const events = results[i];
          const slots = computeSlotsForDay(dateStr, events, workType);
          const available = slots.filter((s) => s.available);
          if (available.length > 0) {
            days.push({
              date: dateStr,
              dayName: noon.toLocaleDateString('nl-NL', { weekday: 'long', timeZone: 'Europe/Amsterdam' }),
              dayShort: noon.toLocaleDateString('nl-NL', { weekday: 'short', timeZone: 'Europe/Amsterdam' }),
              dayNumber: parseInt(
                new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', day: 'numeric' }).format(noon),
                10
              ),
              month: noon.toLocaleDateString('nl-NL', { month: 'long', timeZone: 'Europe/Amsterdam' }),
              monthShort: noon.toLocaleDateString('nl-NL', { month: 'short', timeZone: 'Europe/Amsterdam' }),
              slotsAvailable: available.length,
              totalSlots: slots.length,
              bookedCount: events.length,
              workType,
            });
          }
        }
        return res.status(200).json({ days });
      }

      // Geeft tijdslots terug voor een dag, gerangschikt op route-vriendelijkheid
      case 'getSlots': {
        const { date, address, workType: wtParam } = params;
        if (!date) return res.status(400).json({ error: 'date vereist' });
        const workType = normalizeWorkType(wtParam);

        const events = await getAppointmentsForDay(date);
        const slots = computeSlotsForDay(date, events, workType);

        // Haal adressen bestaande afspraken op
        let existingAddresses = [DEPOT];
        if (address) {
          const addrPromises = events.filter(e => e.contactId).map(e => getContactAddress(e.contactId));
          const addrs = await Promise.all(addrPromises);
          existingAddresses = [DEPOT, ...addrs.filter(Boolean)];
        }

        // Bereken routeafstand van klantadres naar bestaande route
        let distMeters = null;
        if (address && existingAddresses.length > 1) {
          distMeters = await nearestDistanceMeters(existingAddresses, address);
        }

        return res.status(200).json({
          slots,
          existingCount: events.length,
          workType,
          routeDistanceMeters: distMeters,
          routeDistanceKm: distMeters ? Math.round(distMeters / 100) / 10 : null,
        });
      }

      // Boekt een afspraak aan
      case 'createBooking': {
        const { firstName, lastName, phone, email, address, date, time, workType: wtRaw, description } = params;

        if (!firstName || !phone || !date || !time) {
          return res.status(400).json({ error: 'Verplichte velden ontbreken: naam, telefoon, datum, tijd' });
        }

        const workType = normalizeWorkType(wtRaw);
        const durationMin = ghlDurationMinutesForType(workType);

        const contactId = await findOrCreateContact({ firstName, lastName, phone, email, address, workType, description });
        if (!contactId) return res.status(500).json({ error: 'Kon contact niet aanmaken in GHL' });

        const dayCap = maxCustomerAppointmentsPerDay();
        const dayCount = await fetchCalendarEventCountForDay(date, {
          base: GHL_BASE,
          locationId: GHL_LOCATION_ID,
          calendarId: ghlCalendarIdFromEnv(),
          apiKey: GHL_API_KEY,
        });
        if (dayCount !== null && dayCount >= dayCap) {
          return res.status(409).json({
            error: `Er staan al ${dayCap} afspraken op deze dag. Boek een andere dag of plan handmatig in GHL.`,
            code: 'DAY_CAP_REACHED',
          });
        }

        const events = await getAppointmentsForDay(date);
        const [hours, mins] = time.split(':').map(Number);
        const startHourDec = hours + (Number.isFinite(mins) ? mins / 60 : 0);
        if (!slotAvailableForWorkType(date, events, workType, startHourDec)) {
          return res.status(409).json({
            error:
              'Dit tijdstip past niet (blok vol, te weinig geplande tijd, of overlap met een bestaande afspraak). Kies een andere tijd.',
            code: 'SLOT_UNAVAILABLE',
          });
        }

        const startTime = amsterdamWallTimeToDate(date, hours, mins);
        if (!startTime) return res.status(400).json({ error: 'Ongeldige datum of tijd' });
        const endTime = new Date(startTime.getTime() + durationMin * 60 * 1000);

        const title = `${firstName} ${lastName || ''}`.trim() + ` – ${workType}`;
        let apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28',
          },
          body: JSON.stringify({
            calendarId: ghlCalendarIdFromEnv(),
            locationId: GHL_LOCATION_ID,
            contactId,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            title,
            address: address || '',
            appointmentStatus: 'confirmed',
            ignoreLimits: true,
            ignoreDateRange: true,
          }),
        });
        if (!apptRes.ok) {
          apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-04-15',
            },
            body: JSON.stringify({
              calendarId: ghlCalendarIdFromEnv(),
              locationId: GHL_LOCATION_ID,
              contactId,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              title,
              address: address || '',
              ignoreDateRange: true,
            }),
          });
        }
        const apptData = await apptRes.json().catch(() => ({}));
        if (!apptRes.ok) {
          const errTxt = typeof apptData === 'object' && apptData.message ? apptData.message : JSON.stringify(apptData);
          return res.status(502).json({ error: 'Kalender boeken mislukt', detail: String(errTxt).slice(0, 300) });
        }

        const blockPart = startHourDec < DAYPART_SPLIT_HOUR ? 'morning' : 'afternoon';
        const routeStopDay = Math.min(events.length + 1, 7);
        const slotTxt =
          blockPart === 'morning'
            ? `ochtend ${SLOT_LABEL_MORNING_NL}`
            : `middag ${SLOT_LABEL_AFTERNOON_NL}`;
        const tijdafspraakVal = `${formatDateLongNlForBooking(date)}. Geboekt tijdslot: ${slotTxt}. Klant verwacht bezoek binnen dit venster. Routevolgorde deze dag: ${routeStopDay}.`;
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify({
            customFields: [{ id: FIELD_IDS.tijdafspraak, field_value: tijdafspraakVal }],
          }),
        }).catch(() => {});

        const norm = normalizeNlPhone(String(phone || '').replace(/\s/g, ''));
        if (/^\+31[1-9]\d{8}$/.test(norm)) {
          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Version: '2021-04-15',
            },
            body: JSON.stringify({ phone: norm }),
          });
        }

        const confirmTag =
          process.env.BOOKING_CONFIRM_TAG === undefined || process.env.BOOKING_CONFIRM_TAG === ''
            ? 'boeking-bevestigd'
            : process.env.BOOKING_CONFIRM_TAG;
        const tagDisabled = confirmTag === 'false' || confirmTag === 'none';
        const tagFallback = process.env.BOOKING_CONFIRM_TAG_FALLBACK !== 'false' && !tagDisabled;

        const delayMs = Math.min(Math.max(parseInt(process.env.BOOKING_CONFIRM_DELAY_MS || '600', 10) || 600, 0), 5000);
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }

        let workflowTriggered = false;
        if (tagFallback) {
          workflowTriggered = await pulseContactTag(contactId, confirmTag, '[booking]');
          if (workflowTriggered) {
            console.log('[booking] Tag-puls voor workflow:', confirmTag);
          }
        }

        const appointmentId =
          apptData?.id ||
          apptData?.appointmentId ||
          apptData?.appointment?.id ||
          apptData?.data?.id ||
          null;

        return res.status(200).json({
          success: true,
          contactId,
          appointmentId,
          date,
          time,
          messageSent: false,
          whatsappViaApi: false,
          workflowTriggered,
        });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    console.error('Booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
