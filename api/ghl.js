// api/ghl.js — met custom field IDs
import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  formatYyyyMmDdInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import { ghlDurationMinutesForType, normalizeWorkType } from '../lib/booking-blocks.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { fetchWithRetry } from '../lib/retry.js';
import { sendErrorNotification } from '../lib/notify.js';
import { pulseContactTag } from '../lib/ghl-tag.js';
import { signSessionToken, parseUsers, verifySessionToken } from '../lib/session.js';
import {
  deleteGhlCalendarBlock,
  fetchBlockedSlotsAsEvents,
  HK_DEFAULT_BLOCK_SLOT_USER_ID,
  listDeletableBlockIdsForAmsterdamDay,
  listDeletableBlockIdsForMsRange,
  markBlockLikeOnCalendarEvents,
  postFullDayBlockSlot,
  resolveBlockSlotAssignedUserId,
} from '../lib/ghl-calendar-blocks.js';
import {
  DEFAULT_BOOK_START_MORNING,
  SLOT_LABEL_AFTERNOON_NL,
  SLOT_LABEL_MORNING_NL,
} from '../lib/planning-work-hours.js';
import {
  GHL_CONFIG_MISSING_MSG,
  ghlCalendarIdFromEnv,
  ghlLocationIdFromEnv,
} from '../lib/ghl-env-ids.js';
import {
  canonicalGhlEventId,
  eventEndMsGhl,
  eventStartMsGhl,
  getEventStartDayAmsterdam,
} from '../lib/planning/ghl-event-core.js';
import { mapEnrichedGhlEventToAppointment } from '../lib/planning/appointment.js';
import {
  buildCanonicalAddressWritePayload,
  logCanonicalAddressRead,
  logCanonicalAddressWrite,
  readCanonicalAddressLine,
  splitAddressLineToStraatHuis,
} from '../lib/ghl-contact-canonical.js';
import {
  BOOKING_FORM_FIELD_IDS,
  appendBookingCanonFields,
  formatPriceRulesStructuredString,
  normalizePriceLineItems,
  parseStructuredPriceRulesString,
  toPriceNumber,
} from '../lib/booking-canon-fields.js';
import {
  amsterdamDayReadCacheGet,
  amsterdamDayReadCacheKeyBlockedSlots,
  amsterdamDayReadCacheKeyCalendarEvents,
  amsterdamDayReadCacheSet,
  cachedListConfirmedSyntheticEventsForDate,
  invalidateAmsterdamDayGhlReadCachesForDate,
  invalidateRedisSyntheticsCacheForDate,
} from '../lib/amsterdam-day-read-cache.js';
import { deleteConfirmedReservationForContactDate } from '../lib/block-reservation-store.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

function effectiveCalendarId() {
  return ghlCalendarIdFromEnv();
}

/** YYYY-M-DD → YYYY-MM-DD (match met formatYyyyMmDdInAmsterdam) */
function normalizeYyyyMmDdInput(str) {
  if (!str || typeof str !== 'string') return null;
  const p = str.trim().split('-').map((x) => parseInt(x, 10));
  if (p.length !== 3 || p.some((n) => Number.isNaN(n))) return null;
  const [y, mo, d] = p;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** True als het event deze Amsterdam-kalenderdag raakt (o.a. meerdere-dagen vakantie). */
function eventOverlapsAmsterdamDay(e, dateStr) {
  const bounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!bounds) return false;
  const startMs = eventStartMsGhl(e);
  if (Number.isNaN(startMs)) {
    if (e?._hkGhlBlockSlot) return true;
    if (e?._hkBlockReservationSynthetic) return true;
    return false;
  }
  let endMs = eventEndMsGhl(e);
  if (Number.isNaN(endMs)) {
    return getEventStartDayAmsterdam(e) === dateStr;
  }
  const { startMs: dayStart, endMs: dayEnd } = bounds;
  return startMs <= dayEnd && endMs >= dayStart;
}

/**
 * Dedupe GHL-events voor het dashboard.
 * Pass 1: uniek op canoniek event-id (voorkomt zelfde id als number + string).
 * Pass 2: per contactId — behoud het VROEGSTE event; latere events binnen 60 min
 *         van het eerste event voor dit contact worden als retry-duplicaat beschouwd
 *         en weggefilterd. Zo verdwijnen afspraken die door de booking-retry-loop
 *         dubbel zijn aangemaakt (zelfde contact, ±0–30 min verschil).
 *         Opmerking: twee ECHTE afspraken voor dezelfde klant op dezelfde dag (ochtend +
 *         middag) hebben >60 min verschil en blijven dus beide zichtbaar.
 */
/** Alleen echte kalender-events; 60-min dedupe (retry-dubbels). B1-synthetisch wordt apart gemerged. */
function dedupeGhlRealEventsForDashboard(list) {
  const byId = new Set();
  const pass1 = [];
  for (const e of list) {
    const id = canonicalGhlEventId(e);
    if (id) {
      if (byId.has(id)) continue;
      byId.add(id);
    }
    pass1.push(e);
  }

  pass1.sort((a, b) => (eventStartMsGhl(a) || 0) - (eventStartMsGhl(b) || 0));

  const firstSeenMs = new Map();
  const out = [];
  for (const e of pass1) {
    const rawCid = e.contactId || e.contact_id || e.contact?.id;
    const cid = rawCid != null && String(rawCid).trim() !== '' ? String(rawCid).trim() : '';
    const ms = eventStartMsGhl(e);
    if (cid && !Number.isNaN(ms)) {
      const first = firstSeenMs.get(cid);
      if (first === undefined) {
        firstSeenMs.set(cid, ms);
      } else if (ms - first < 60 * 60 * 1000) {
        continue;
      } else {
        firstSeenMs.set(cid, ms);
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * Dedupe GHL-events voor het dashboard.
 * B1 Redis-synthetische rijen niet wegfilteren als “retry-duplicaat” van een echt event
 * (zelfde contact binnen 60 min) — anders verdwijnt de enige zichtbare rij na refresh.
 */
function dedupeGhlEventsForDashboard(list) {
  const reals = list.filter((e) => !e._hkBlockReservationSynthetic);
  const synthetics = list.filter((e) => e._hkBlockReservationSynthetic);
  const dedupedReals = dedupeGhlRealEventsForDashboard(reals);
  const realCids = new Set(
    dedupedReals
      .map((e) => {
        const raw = e.contactId || e.contact_id || e.contact?.id;
        return raw != null && String(raw).trim() ? String(raw).trim() : '';
      })
      .filter(Boolean)
  );
  const synthKeep = synthetics.filter((e) => {
    const raw = e.contactId || e.contact_id;
    const cid = raw != null && String(raw).trim() ? String(raw).trim() : '';
    return cid && !realCids.has(cid);
  });
  const merged = [...dedupedReals, ...synthKeep];
  merged.sort((a, b) => (eventStartMsGhl(a) || 0) - (eventStartMsGhl(b) || 0));
  return merged;
}

// Custom field ID mapping
const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  postcode:            '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:          'mFRQjlUppycMfyjENKF9',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  prijs:               'HGjlT6ofaBiMz3j2HsXL',
  prijs_regels:        'gPjrUG2eH81PeALh8tVS',
  tijdafspraak:        'RfKARymCOYYkufGY053T',
  /** Zelfde ID als api/cron/morning-messages.js — voor ETA/ochtend-template in workflow */
  geplande_aankomst:   'XELcOSdWq3tqRtpLE5x8',
  opmerkingen:         'LCIFALarX3WZI5jsBbDA',
};

function getField(contact, fieldId) {
  if (!contact?.customFields) return '';
  const fid = String(fieldId);
  const field = contact.customFields.find(
    (f) => f.id === fid || f.fieldId === fid || f.customFieldId === fid
  );
  const raw = field?.value ?? field?.field_value;
  return raw != null && raw !== '' ? String(raw) : '';
}

/**
 * GHL: start/einde van een kalender-item zetten.
 * Sommige omgevingen gebruiken PUT …/appointments/:id, andere …/events/:id — we proberen beide + API-versies.
 */
async function putCalendarStartEnd(eventId, startIso, endIso) {
  if (!eventId) return { ok: false, err: 'Geen kalender-id' };

  const body = JSON.stringify({
    calendarId: effectiveCalendarId(),
    locationId: ghlLocationIdFromEnv(),
    startTime: startIso,
    endTime: endIso,
    ignoreLimits: true,
    ignoreDateRange: true,
  });

  const paths = [
    `${GHL_BASE}/calendars/events/appointments/${eventId}`,
    `${GHL_BASE}/calendars/events/${eventId}`,
  ];
  const versions = ['2021-04-15', '2021-07-28'];
  let lastErr = '';

  for (const url of paths) {
    for (const Version of versions) {
      const res = await fetchWithRetry(
        url,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version,
          },
          body,
        },
        0
      );
      if (res.ok) {
        return { ok: true, url: url.split('/').slice(-3).join('/') };
      }
      const t = await res.text();
      lastErr = `${res.status} ${t}`.slice(0, 400);
    }
  }
  return { ok: false, err: lastErr || 'Kalender PUT mislukt' };
}

function requireAuth(req, res) {
  const token = req.headers['x-hk-auth'];
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: 'Niet ingelogd of sessie verlopen' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ─── Diagnose (geen auth vereist) ─────────────────────────────────────────
  if (action === 'health') {
    const users = parseUsers();
    const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
    const build = sha ? sha.slice(0, 7) : undefined;
    return res.status(200).json({
      ok: true,
      ...(build ? { build } : {}),
      hasUsers: Object.keys(users).length > 0,
      hasSecret: !!process.env.SESSION_SECRET,
      hasGhlApiKey: !!GHL_API_KEY,
      hasGhlLocationId: Boolean(ghlLocationIdFromEnv()),
      hasGhlCalendarId: Boolean(ghlCalendarIdFromEnv()),
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  // ─── Login (verplaatst vanuit api/auth.js) ───────────────────────────────
  if (action === 'auth') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const u = String(body.user || '').trim().toLowerCase();
    const p = String(body.password || '');
    await new Promise((r) => setTimeout(r, 300));
    const users = parseUsers();
    if (!u || !users[u] || users[u] !== p) {
      return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
    }
    const token = signSessionToken(u);
    // `day` meesturen voor backward-compat met gecachte clients die nog de dagcheck doen
    const day = formatYyyyMmDdInAmsterdam(new Date()) || '';
    return res.status(200).json({ token, user: u, day });
  }
  // ────────────────────────────────────────────────────────────────────────

  if (!requireAuth(req, res)) return;

  const locConfigured = ghlLocationIdFromEnv();
  const calConfigured = ghlCalendarIdFromEnv();
  if (!GHL_API_KEY || !locConfigured || !calConfigured) {
    return res.status(503).json({ error: GHL_CONFIG_MISSING_MSG });
  }

  try {
    switch (action) {

      case 'getAppointments': {
        const gaT0 = Date.now();
        const gaPerf = { route: 'getAppointments', ghl_calendar_events_ms: 0, blocked_slots_ms: 0, redis_b1_synthetic_ms: 0, contact_fetch_sum_ms: 0, filter_dedupe_map_ms: 0 };

        const dateRaw = req.query.date;
        const date = normalizeYyyyMmDdInput(
          Array.isArray(dateRaw) ? String(dateRaw[0]) : String(dateRaw || '')
        );
        if (!date) return res.status(400).json({ error: 'Ongeldige datum' });
        const bounds = amsterdamCalendarDayBoundsMs(date);
        if (!bounds) return res.status(400).json({ error: 'Ongeldige datum' });
        const { startMs, endMs } = bounds;
        const locId = locConfigured;
        const calId = calConfigured;
        const blockSlotUserId = await resolveBlockSlotAssignedUserId(
          GHL_BASE,
          GHL_API_KEY,
          locId,
          calId
        );
        const url = `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(locId)}&calendarId=${encodeURIComponent(calId)}&startTime=${startMs}&endTime=${endMs}`;
        const calKey = amsterdamDayReadCacheKeyCalendarEvents(locId, calId, date);
        const tCalEv = Date.now();
        let events = amsterdamDayReadCacheGet(calKey);
        if (events !== undefined) {
          gaPerf.ghl_calendar_events_ms = Date.now() - tCalEv;
        } else {
          const response = await fetchWithRetry(url, {
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' },
          });
          const data = await response.json();
          gaPerf.ghl_calendar_events_ms = Date.now() - tCalEv;
          events = data?.events || [];
          if (response.ok) amsterdamDayReadCacheSet(calKey, events);
        }

        markBlockLikeOnCalendarEvents(events);

        const blkKey = amsterdamDayReadCacheKeyBlockedSlots(locId, calId, startMs, endMs, blockSlotUserId);
        const tBlk = Date.now();
        let blockedAsEvents = amsterdamDayReadCacheGet(blkKey);
        if (blockedAsEvents === undefined) {
          const fetched = await fetchBlockedSlotsAsEvents(GHL_BASE, {
            locationId: locId,
            calendarId: calId,
            startMs: bounds.startMs,
            endMs: bounds.endMs,
            apiKey: GHL_API_KEY,
            assignedUserId: blockSlotUserId,
          });
          blockedAsEvents = Array.isArray(fetched) ? fetched : [];
          amsterdamDayReadCacheSet(blkKey, blockedAsEvents);
        }
        gaPerf.blocked_slots_ms = Date.now() - tBlk;
        if (blockedAsEvents.length) {
          events = [...events, ...blockedAsEvents];
        }

        /** Model B1: geen GHL timed appointment — tonen als planner-rij via Redis + contact (tijdafspraak). */
        let blockBookingSynthetic = [];
        try {
          const tRedis = Date.now();
          blockBookingSynthetic = await cachedListConfirmedSyntheticEventsForDate(date);
          gaPerf.redis_b1_synthetic_ms = Date.now() - tRedis;
        } catch (err) {
          console.warn('[ghl] getAppointments block reservations:', err?.message || err);
        }
        for (const ev of blockBookingSynthetic) {
          const cid = String(ev.contactId || ev.contact_id || '').trim();
          if (!cid) continue;
          events.push({
            ...ev,
            id: `hk-b1:${cid}:${date}`,
            _hkBlockReservationSynthetic: true,
          });
        }

        /** Eén overlap-check per event; verrijking gebruikt die niet — alleen events op deze dag hoeven contact. */
        const overlapsAmsterdamDay = events.map((e) => eventOverlapsAmsterdamDay(e, date));

        const contactIdKey = (id) => (id == null ? '' : String(id).trim());
        const uniqueCids = [
          ...new Set(
            events
              .map((e, i) => (overlapsAmsterdamDay[i] ? contactIdKey(e.contactId || e.contact_id) : ''))
              .filter(Boolean)
          ),
        ];

        const contactMap = {};
        const tContacts0 = Date.now();
        await Promise.all(
          uniqueCids.map(async (cidKey) => {
            try {
              const cr = await fetchWithRetry(
                `${GHL_BASE}/contacts/${encodeURIComponent(cidKey)}`,
                { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' } }
              );
              if (!cr.ok) return;
              const cd = await cr.json();
              contactMap[cidKey] = cd?.contact || cd;
            } catch (_) {}
          })
        );
        gaPerf.contact_fetch_sum_ms = Date.now() - tContacts0;

        function enrichEvent(e, contact) {
          e.contact = contact;
          if (contact?.id) e.contactId = contact.id;
          const canonStreetHouse = getField(contact, BOOKING_FORM_FIELD_IDS.straat_huisnummer);
          const canonPostcode = getField(contact, BOOKING_FORM_FIELD_IDS.postcode);
          const canonWoonplaats = getField(contact, BOOKING_FORM_FIELD_IDS.woonplaats);
          const splitCanon = splitAddressLineToStraatHuis(canonStreetHouse);
          const straat = splitCanon.straatnaam || getField(contact, FIELD_IDS.straatnaam);
          const huisnr = splitCanon.huisnummer || getField(contact, FIELD_IDS.huisnummer);
          const postcode =
            canonPostcode ||
            getField(contact, FIELD_IDS.postcode) ||
            String(contact.postalCode || '')
              .replace(/\s+/g, ' ')
              .trim();
          const woonplaats = canonWoonplaats || getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
          const fromCf     = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          const canonical  = readCanonicalAddressLine(contact);
          e.parsedAddress = canonical;
          if (fromCf) {
            e.parsedStraatnaam = straat;
            e.parsedHuisnummer = huisnr;
            e.parsedPostcode   = postcode;
            e.parsedWoonplaats = woonplaats;
          } else if (canonical) {
            // Alleen address1 / losse regel: hele regel in straat voor Maps (zelfde tekst als readCanonicalAddressLine).
            e.parsedStraatnaam = canonical;
            e.parsedHuisnummer = '';
            e.parsedPostcode   = '';
            e.parsedWoonplaats = '';
            logCanonicalAddressRead('getAppointments_fallback_address1', {
              contactId: contact.id,
              preview: canonical.slice(0, 100),
            });
          } else {
            e.parsedStraatnaam = '';
            e.parsedHuisnummer = '';
            e.parsedPostcode   = '';
            e.parsedWoonplaats = '';
          }
          const canonType = getField(contact, BOOKING_FORM_FIELD_IDS.type_onderhoud);
          const canonWerkzaamheden = getField(contact, BOOKING_FORM_FIELD_IDS.probleemomschrijving);
          const werkzaamheden = canonWerkzaamheden || getField(contact, FIELD_IDS.probleemomschrijving);
          e.parsedJobType = canonType || '';
          if (e._hkBlockReservationSynthetic) {
            const blk = e._hkSyntheticBlock === 'afternoon' ? 'afternoon' : 'morning';
            const windowLabel =
              blk === 'afternoon' ? SLOT_LABEL_AFTERNOON_NL : SLOT_LABEL_MORNING_NL;
            const titleStr = typeof e.title === 'string' ? e.title : '';
            const techTitle = titleStr.includes('__hk_block_res__');
            e.parsedWork =
              werkzaamheden ||
              (techTitle
                ? `Online geboekt — ${blk === 'morning' ? 'ochtend' : 'middag'} (${windowLabel})`
                : e.title);
          } else {
            e.parsedWork = werkzaamheden || e.title;
          }
          const canonPriceTotal = getField(contact, BOOKING_FORM_FIELD_IDS.prijs_totaal);
          e.parsedPrice      = canonPriceTotal || getField(contact, FIELD_IDS.prijs);
          e.parsedNotes      = getField(contact, FIELD_IDS.opmerkingen);
          e.parsedTimeWindow =
            getField(contact, BOOKING_FORM_FIELD_IDS.tijdslot) ||
            getField(contact, FIELD_IDS.tijdafspraak) ||
            null;
          e.parsedPaymentStatus = getField(contact, BOOKING_FORM_FIELD_IDS.betaal_status) || '';
          const canonPrijsRegels = getField(contact, BOOKING_FORM_FIELD_IDS.prijs_regels);
          let parsedPrijsRegels = parseStructuredPriceRulesString(canonPrijsRegels);
          if (parsedPrijsRegels.length === 0) {
            const prijsRegelsRaw = getField(contact, FIELD_IDS.prijs_regels);
            parsedPrijsRegels = parseStructuredPriceRulesString(prijsRegelsRaw);
          }
          e.parsedExtras = parsedPrijsRegels;
        }

        const tEnrich0 = Date.now();
        const enriched = events.map((e, i) => {
          if (!overlapsAmsterdamDay[i]) return e;
          const rawCid = e.contactId || e.contact_id;
          if (!rawCid) return e;
          const cidKey = contactIdKey(rawCid);
          if (!cidKey) return e;
          e.contactId = rawCid;
          const contact = contactMap[cidKey];
          if (contact) enrichEvent(e, contact);
          return e;
        });
        gaPerf.contact_enrich_sync_ms = Date.now() - tEnrich0;

        /** Events die deze Amsterdam-dag raken (ook langlopende blokken / vakantie). */
        const tFilt0 = Date.now();
        const filtered = enriched.filter((e, i) => overlapsAmsterdamDay[i]);
        const overlapDropped = enriched.length - filtered.length;
        if (overlapDropped > 0) {
          console.log(
            JSON.stringify({
              event: 'BOOKING_COMPLETE_FILTER',
              phase: 'overlap_amsterdam_day',
              dateStr: date,
              before: enriched.length,
              after: filtered.length,
              dropped: overlapDropped,
            })
          );
        }
        gaPerf.filter_overlap_ms = Date.now() - tFilt0;
        const tDedupe0 = Date.now();
        const unique = dedupeGhlEventsForDashboard(filtered);
        if (filtered.length !== unique.length) {
          console.log(
            JSON.stringify({
              event: 'BOOKING_COMPLETE_FILTER',
              phase: 'dedupe',
              dateStr: date,
              before: filtered.length,
              after: unique.length,
              dropped: filtered.length - unique.length,
            })
          );
        }
        gaPerf.dedupe_ms = Date.now() - tDedupe0;

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-HK-GetAppointments-Filter', 'v5-amsterdam-day+id+contact-slot+b1-redis');
        const tMapAppt0 = Date.now();
        const appointments = unique.map((ev, i) => mapEnrichedGhlEventToAppointment(ev, i, date));
        gaPerf.map_appointments_ms = Date.now() - tMapAppt0;
        gaPerf.total_ms = Date.now() - gaT0;
        gaPerf.unique_contact_fetches = uniqueCids.length;
        gaPerf.event_count_before_filter = enriched.length;
        const clientRows = appointments.filter((a) => !a.isCalBlock);
        const nKlaarFromContact = clientRows.filter((a) => a.status === 'klaar').length;
        console.log('[timing getAppointments]', JSON.stringify(gaPerf));
        console.log(
          JSON.stringify({
            event: 'BOOKING_COMPLETE_RELOAD',
            dateStr: date,
            rowsReturned: appointments.length,
            clientRows: clientRows.length,
            klaarFromDatumField: nKlaarFromContact,
            syntheticRows: appointments.filter((a) => a.isSyntheticBlockBooking).length,
          })
        );
        return res.status(200).json({ appointments });
      }

      case 'updateContactDashboard': {
        const editedBy = String(req.body?.editedBy || '').toLowerCase().trim();
        if (editedBy !== 'daan') {
          return res.status(403).json({ error: 'Alleen ingelogde gebruiker Daan kan dit endpoint gebruiken' });
        }

        const {
          contactId,
          firstName,
          lastName,
          phone,
          straatnaam,
          huisnummer,
          postcode,
          woonplaats,
          typeOnderhoud,
          probleemomschrijving,
          tijdafspraak,
          opmerkingen,
          prijs,
          appointmentTime,
          routeDate,
          ghlAppointmentId,
          durationMin,
        } = req.body;

        if (!contactId) {
          return res.status(400).json({ error: 'contactId vereist' });
        }

        const customFields = [];
        const pushField = (id, val) => {
          if (val === undefined || val === null) return;
          const s = String(val).trim();
          customFields.push({ id, field_value: s });
        };

        pushField(FIELD_IDS.straatnaam, straatnaam);
        pushField(FIELD_IDS.huisnummer, huisnummer);
        pushField(FIELD_IDS.postcode, postcode);
        pushField(FIELD_IDS.woonplaats, woonplaats);
        pushField(FIELD_IDS.type_onderhoud, typeOnderhoud);
        pushField(FIELD_IDS.probleemomschrijving, probleemomschrijving);
        pushField(FIELD_IDS.tijdafspraak, tijdafspraak);
        pushField(FIELD_IDS.opmerkingen, opmerkingen);
        pushField(FIELD_IDS.prijs, prijs);
        const bookingCanon = appendBookingCanonFields(customFields, {
          type_onderhoud: typeOnderhoud,
          probleemomschrijving,
        });
        console.log('[BOOKING_CANON_WRITE]', {
          typeOnderhoud: bookingCanon.written.type_onderhoud || '',
          probleemomschrijving: bookingCanon.written.probleemomschrijving || '',
        });

        const payload = {};
        if (firstName !== undefined) payload.firstName = String(firstName).trim();
        if (lastName !== undefined) payload.lastName = String(lastName).trim();
        if (phone !== undefined) payload.phone = String(phone).replace(/\s/g, '');
        if (bookingCanon.customFields.length) payload.customFields = bookingCanon.customFields;

        const composedAddr = [straatnaam, huisnummer, postcode, woonplaats]
          .map((x) => (x != null ? String(x).trim() : ''))
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (composedAddr) payload.address1 = composedAddr;

        if (Object.keys(payload).length === 0) {
          return res.status(400).json({ error: 'Geen velden om bij te werken' });
        }

        logCanonicalAddressWrite('updateContactDashboard', {
          contactId,
          address1: payload.address1 || null,
          customFieldIds: customFields.map((f) => f.id),
        });

        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify(payload),
        });

        if (!putRes.ok) {
          const t = await putRes.text();
          console.error('[updateContactDashboard] GHL PUT contact:', t);
          return res.status(502).json({ error: 'GHL contact bijwerken mislukt', detail: t.slice(0, 400) });
        }

        let calendarSynced = false;
        let calendarError;
        if (ghlAppointmentId && routeDate && appointmentTime) {
          const dur = Math.max(5, Math.min(480, Number(durationMin) || 30));
          const tm = String(appointmentTime).trim().replace(/^~/, '');
          const parts = tm.split(':');
          const hNum = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
          const mNum = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
          // DST-bewust: amsterdamWallTimeToDate ipv hardgecodeerd +01:00
          const startD = amsterdamWallTimeToDate(routeDate, hNum, mNum);
          if (startD) {
            const startIso = startD.toISOString();
            const endIso   = new Date(startD.getTime() + dur * 60 * 1000).toISOString();
            const cal = await putCalendarStartEnd(ghlAppointmentId, startIso, endIso);
            calendarSynced = cal.ok;
            if (!cal.ok) calendarError = cal.err;
          }
        }

        return res.status(200).json({
          success: true,
          calendarSynced,
          calendarError: calendarError || undefined,
        });
      }

      case 'completeAppointment': {
        const { contactId, appointmentId, type, sendReview, lastService, totalPrice, extras, routeDate } =
          req.body || {};
        if (!contactId) return res.status(400).json({ error: 'contactId vereist' });

        const today = formatYyyyMmDdInAmsterdam(new Date()) || new Date().toISOString().split('T')[0];
        /** Route-dag in de planner (YYYY-MM-DD); bewaart afgerond op die dienst-dag i.p.v. alleen “vandaag”. */
        const serviceDay = normalizeYyyyMmDdInput(String(routeDate || '').trim()) || today;
        const customFields = [
          { id: 'hiTe3Yi5TlxheJq4bLzy', field_value: serviceDay }, // datum_laatste_onderhoud = route-dag
          { id: 'xAg0jUYsOL6IZZjdHuRq', field_value: 'Afgerond' }, // legacy Betalingsstatus
        ];
        if (type === 'installatie') {
          customFields.push({ id: 'kYP2SCmhZ21Ig0aaLl5l', field_value: serviceDay }); // datum_installatie
        }
        if (totalPrice != null) {
          customFields.push({ id: FIELD_IDS.prijs, field_value: String(totalPrice) });
        }
        const extrasNorm = normalizePriceLineItems(Array.isArray(extras) ? extras : []);
        if (extrasNorm.length > 0) {
          customFields.push({ id: FIELD_IDS.prijs_regels, field_value: JSON.stringify(extrasNorm) });
        }
        const canonicalPrijsRegels = formatPriceRulesStructuredString(extrasNorm);
        const canonicalPrijsTotaal = toPriceNumber(totalPrice);
        const bookingCanon = appendBookingCanonFields(customFields, {
          prijs_regels: canonicalPrijsRegels,
          prijs_totaal: canonicalPrijsTotaal,
          betaal_status: 'Afgerond',
        });
        console.log('[BOOKING_PRICE_DEBUG]', {
          contactId,
          extrasCount: extrasNorm.length,
          serializedPrijsRegels: canonicalPrijsRegels,
          prijsTotaal: canonicalPrijsTotaal,
        });
        console.log(
          JSON.stringify({
            event: 'BOOKING_COMPLETE_PERSIST',
            contactId,
            routeDateRequested: routeDate != null ? String(routeDate) : null,
            serviceDayWritten: serviceDay,
            appointmentId: appointmentId != null ? String(appointmentId) : null,
            prijsTotaal: canonicalPrijsTotaal,
            prijsRegelsLines: extrasNorm.length,
          })
        );
        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify({ customFields: bookingCanon.customFields }),
          _allowPostRetry: false,
        });
        if (!putRes.ok) {
          const detail = (await putRes.text().catch(() => '')).slice(0, 400);
          console.error('[completeAppointment] GHL contact PUT mislukt:', putRes.status, detail);
          return res.status(502).json({ error: 'Kon afsluitvelden niet opslaan in GHL', detail });
        }

        const tagErrors = [];
        const tagOk = await addTag(contactId, 'factuur-versturen').catch((e) => { tagErrors.push(e.message); return false; });
        if (sendReview) {
          await addTag(contactId, 'review-mail-versturen').catch((e) => { tagErrors.push(e.message); });
        }
        if (appointmentId) {
          await updateOpportunityStage(contactId, 'Uitgevoerd').catch((e) => {
            console.warn('[completeAppointment] opportunity stage update mislukt:', e.message);
          });
        }

        return res.status(200).json({
          success: true,
          tagOk: tagOk !== false,
          tagErrors: tagErrors.length ? tagErrors : undefined,
        });
      }

      case 'updatePriceLines': {
        const { contactId, extras, totalPrice } = req.body || {};
        if (!contactId) return res.status(400).json({ error: 'contactId vereist' });
        const extrasArr = normalizePriceLineItems(Array.isArray(extras) ? extras : []);
        const totalNum = toPriceNumber(totalPrice);
        const customFields = [];
        if (totalNum !== null) {
          customFields.push({ id: FIELD_IDS.prijs, field_value: String(totalNum) });
        }
        if (extrasArr.length > 0) {
          customFields.push({ id: FIELD_IDS.prijs_regels, field_value: JSON.stringify(extrasArr) });
        } else {
          customFields.push({ id: FIELD_IDS.prijs_regels, field_value: '' });
        }
        const canonicalPrijsRegels = formatPriceRulesStructuredString(extrasArr);
        const bookingCanon = appendBookingCanonFields(customFields, {
          prijs_regels: canonicalPrijsRegels,
          prijs_totaal: totalNum,
        });
        console.log('[BOOKING_PRICE_DEBUG]', {
          contactId,
          extrasCount: extrasArr.length,
          serializedPrijsRegels: canonicalPrijsRegels,
          prijsTotaal: totalNum,
        });
        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify({ customFields: bookingCanon.customFields }),
          _allowPostRetry: false,
        });
        if (!putRes.ok) {
          const detail = (await putRes.text().catch(() => '')).slice(0, 400);
          return res.status(502).json({ error: 'Kon prijsregels niet opslaan in GHL', detail });
        }
        return res.status(200).json({ success: true, savedLines: extrasArr.length, totalPrice: totalNum });
      }

      case 'saveRouteTimes': {
        // Custom field geplande aankomst + optioneel GHL-kalender bijwerken
        const { routeTimes } = req.body; // [{ contactId, plannedTime, ghlAppointmentId?, routeDate?, startTime?, durationMin? }]
        if (!Array.isArray(routeTimes) || routeTimes.length === 0) {
          return res.status(400).json({ error: 'routeTimes array vereist' });
        }
        const results = [];
        const calendarErrors = [];
        let calendarSynced = 0;
        for (const row of routeTimes) {
          const { contactId, plannedTime, ghlAppointmentId, routeDate, startTime, durationMin } = row;
          if (!contactId || !plannedTime) continue;

          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              customFields: [{ id: 'XELcOSdWq3tqRtpLE5x8', field_value: plannedTime }]
            })
          });
          results.push({ contactId, plannedTime });

          if (ghlAppointmentId && routeDate && startTime) {
            const dur = Math.max(5, Math.min(480, Number(durationMin) || 30));
            const tm = String(startTime).trim().replace(/^~/, '');
            const parts = tm.split(':');
            const hNum = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
            const mNum = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
            const startD = amsterdamWallTimeToDate(routeDate, hNum, mNum);
            const startMs = startD?.getTime();
            if (startD == null || Number.isNaN(startMs)) {
              calendarErrors.push({ ghlAppointmentId, err: 'Ongeldige datum/tijd' });
              continue;
            }
            const startIso = new Date(startMs).toISOString();
            const endIso   = new Date(startMs + dur * 60 * 1000).toISOString();

            const putResult = await putCalendarStartEnd(ghlAppointmentId, startIso, endIso);
            if (putResult.ok) {
              calendarSynced++;
              console.log(`[saveRouteTimes] Kalender OK ${ghlAppointmentId} via ${putResult.url}`);
            } else {
              console.warn(`[saveRouteTimes] Kalender update mislukt ${ghlAppointmentId}:`, putResult.err);
              calendarErrors.push({ ghlAppointmentId, err: putResult.err?.slice(0, 220) || 'onbekend' });
            }
          }
        }
        console.log(`[saveRouteTimes] ${results.length} contacten bijgewerkt, kalender OK: ${calendarSynced}, fouten: ${calendarErrors.length}`);
        return res.status(200).json({
          success: true,
          saved: results.length,
          calendarSynced,
          calendarErrors: calendarErrors.length ? calendarErrors : undefined,
        });
      }

      case 'createAppointment': {
        const { name, phone, address, date, time, type: apptType, desc, contactId: existingContactId } = req.body;

        // Stap 1: contact opzoeken of aanmaken
        let contactId = existingContactId;
        if (!contactId) {
          // Zoek bestaand contact op telefoonnummer
          // Zoek op nummer (GHL duplicate check)
          const searchPhone = phone ? phone.replace(/\s/g, '') : '';
          if (searchPhone) {
            const searchRes = await fetchWithRetry(
              `${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(searchPhone)}`,
              { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              contactId = searchData?.contact?.id || null;
            }
          }
          // Zoek op naam als telefoonnummer niet gevonden
          if (!contactId && name) {
            const nameSearch = await fetchWithRetry(
              `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(name)}&limit=1`,
              { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
            );
            if (nameSearch.ok) {
              const nameData = await nameSearch.json();
              contactId = nameData?.contacts?.[0]?.id || null;
            }
          }
          // Nieuw contact aanmaken als niet gevonden
          if (!contactId) {
            const nameParts = name.trim().split(' ');
            const createRes = await fetchWithRetry(`${GHL_BASE}/contacts/`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
              body: JSON.stringify({
                locationId: GHL_LOCATION_ID,
                firstName: nameParts[0] || name,
                lastName: nameParts.slice(1).join(' ') || '',
                phone: searchPhone || '',
                address1: address || '',
              })
            });
            if (createRes.ok) {
              const createData = await createRes.json();
              contactId = createData?.contact?.id || null;
            }
          }
        }

        if (!contactId) return res.status(400).json({ error: 'Kon geen contact vinden of aanmaken' });

        // Stap 2: canoniek adres (address1 + straat/huis-CF) + type/omschrijving
        if (address) {
          const { address1, customFields: addrCf } = buildCanonicalAddressWritePayload(address);
          const bookingCanon = appendBookingCanonFields(
            [
              ...addrCf,
              { id: FIELD_IDS.type_onderhoud, field_value: apptType || 'reparatie' },
              { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
            ],
            {
              type_onderhoud: apptType || 'reparatie',
              probleemomschrijving: desc || '',
            }
          );
          console.log('[BOOKING_CANON_WRITE]', {
            typeOnderhoud: bookingCanon.written.type_onderhoud || '',
            probleemomschrijving: bookingCanon.written.probleemomschrijving || '',
          });
          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              address1,
              customFields: bookingCanon.customFields,
            }),
          });
          logCanonicalAddressWrite('createAppointment', { contactId, address1 });
        }

        // Stap 3: agenda-afspraak aanmaken (met retry bij slot-conflict)
        const [hours, minutes] = (time || DEFAULT_BOOK_START_MORNING).split(':').map(Number);
        const durationMin = ghlDurationMinutesForType(normalizeWorkType(apptType));

        // Basisstarttijd via DST-bewuste helper (niet hardgecodeerd +01:00; anders dag-overschrijding in CEST).
        const baseStartDt = amsterdamWallTimeToDate(date, hours, minutes);
        if (!baseStartDt) {
          return res.status(400).json({ error: 'Ongeldige datum of tijd voor afspraak' });
        }
        const baseStartMs = baseStartDt.getTime();

        let appointmentId = null;
        let lastError = null;
        // Probeer de gevraagde tijd, dan stapsgewijs eerder (zodat de afspraak op de juiste dag blijft)
        const offsets = [0, -5, 5, -10, 10, -15, 15, -30, 30];
        for (const offsetMin of offsets) {
          const startMs = baseStartMs + offsetMin * 60 * 1000;
          const startTime = new Date(startMs);
          const endTime   = new Date(startMs + durationMin * 60 * 1000);

          const apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
            body: JSON.stringify({
              calendarId: effectiveCalendarId(),
              locationId: ghlLocationIdFromEnv(),
              contactId,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              title: `${name} – ${apptType || 'afspraak'}`,
              appointmentStatus: 'confirmed',
              ignoreLimits: true,
            })
          });

          if (apptRes.ok) {
            const apptData = await apptRes.json();
            appointmentId = apptData?.id;
            break;
          }
          const errText = await apptRes.text();
          lastError = errText;
          if (!errText.includes('slot') && !errText.includes('available')) break; // ander fout → niet retrien
        }

        if (!appointmentId) {
          console.error('[createAppointment] Alle tijdslots geprobeerd, mislukt:', lastError);
          // Contact is wel aangemaakt/gevonden — geef dat terug zodat de afspraak zichtbaar blijft
          return res.status(200).json({ success: true, contactId, appointmentId: null, warning: 'Kalender-slot niet beschikbaar, alleen contact opgeslagen' });
        }

        return res.status(200).json({ success: true, contactId, appointmentId });
      }

      case 'sendETA': {
        if (!GHL_API_KEY) {
          return res.status(503).json({ error: 'GHL_API_KEY ontbreekt — ETA kan niet naar GHL' });
        }
        const { contactId, eta } = req.body;
        if (!contactId) return res.status(400).json({ error: 'contactId verplicht' });
        const etaStr = String(eta ?? '').trim();
        if (!etaStr) {
          return res.status(400).json({
            error: 'Geen aankomsttijd (ETA) bekend. Optimaliseer of bevestig eerst de route, of vul de tijd in GHL.',
          });
        }
        const etaTag = process.env.GHL_ETA_WORKFLOW_TAG || 'monteur-eta';
        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
          body: JSON.stringify({
            customFields: [{ id: FIELD_IDS.geplande_aankomst, field_value: etaStr }],
          }),
        });
        if (!putRes.ok) {
          const detail = (await putRes.text().catch(() => '')).slice(0, 400);
          return res.status(502).json({
            error: `GHL: geplande aankomst opslaan mislukt (${putRes.status})`,
            detail,
          });
        }
        await new Promise((r) => setTimeout(r, 400));
        const tagPulseOk = await pulseContactTag(contactId, etaTag, '[ghl sendETA]');
        if (!tagPulseOk) {
          return res.status(502).json({
            error: 'ETA wel opgeslagen, maar workflow-tag niet gezet — controleer tagnaam in GHL en env GHL_ETA_WORKFLOW_TAG',
            workflowTag: etaTag,
            tagPulseOk: false,
          });
        }
        return res.status(200).json({ success: true, workflowTag: etaTag, tagPulseOk: true });
      }

      case 'deleteAppointment': {
        const { ghlAppointmentId: delId } = req.body;
        if (!delId) return res.status(400).json({ error: 'ghlAppointmentId vereist' });

        const delPaths = [
          `${GHL_BASE}/calendars/events/appointments/${delId}`,
          `${GHL_BASE}/calendars/events/${delId}`,
        ];
        let delOk = false;
        let delErr = '';
        for (const url of delPaths) {
          for (const Version of ['2021-04-15', '2021-07-28']) {
            const r = await fetchWithRetry(url, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version },
            }, 0);
            if (r.ok || r.status === 404) { delOk = true; break; }
            const t = await r.text().catch(() => '');
            delErr = `${r.status} ${t}`.slice(0, 300);
          }
          if (delOk) break;
        }
        if (!delOk) {
          console.warn('[deleteAppointment] mislukt:', delErr);
          return res.status(500).json({ error: 'GHL verwijderen mislukt', detail: delErr });
        }
        console.log('[deleteAppointment] verwijderd:', delId);
        return res.status(200).json({ success: true });
      }

      case 'deletePlannerBooking': {
        const { contactId, routeDate, rowId, isSyntheticB1, isCalBlock } = req.body || {};
        console.log('[BOOKING_DELETE_START]', {
          contactId: contactId ?? null,
          routeDate: routeDate ?? null,
          rowId: rowId ?? null,
          isSyntheticB1: !!isSyntheticB1,
          isCalBlock: !!isCalBlock,
        });

        if (isCalBlock) {
          return res.status(400).json({
            error:
              'Dit is een agenda-blok, geen klantboeking. Gebruik “Blokkeer dag opheffen” / GHL om het blok te verwijderen.',
          });
        }
        const cid = String(contactId ?? '').trim();
        const dateNorm = normalizeYyyyMmDdInput(String(routeDate ?? ''));
        if (!cid || !dateNorm) {
          return res.status(400).json({ error: 'contactId en geldige routeDate (YYYY-MM-DD) vereist' });
        }

        const rid = String(rowId ?? '').trim();
        const hkRow = /^hk-b1:([^:]+):(\d{4}-\d{2}-\d{2})$/i.exec(rid);
        if (hkRow) {
          if (hkRow[1] !== cid) {
            return res.status(400).json({ error: 'contactId hoort niet bij deze plannerrij' });
          }
          if (hkRow[2] !== dateNorm) {
            return res.status(400).json({ error: 'routeDate hoort niet bij deze plannerrij' });
          }
        }

        const synthetic = Boolean(isSyntheticB1) || /^hk-b1:/i.test(rid);

        const redisOut = await deleteConfirmedReservationForContactDate(cid, dateNorm);
        console.log('[BOOKING_DELETE_REDIS]', redisOut);
        invalidateRedisSyntheticsCacheForDate(dateNorm);

        let ghlApptResult = { attempted: false, ok: null, detail: '' };
        const skipGhlDelete =
          synthetic ||
          !rid ||
          /^row-/i.test(rid) ||
          /^local-/i.test(rid) ||
          /^hk-b1:/i.test(rid);
        if (!skipGhlDelete) {
          ghlApptResult.attempted = true;
          const delPaths = [
            `${GHL_BASE}/calendars/events/appointments/${encodeURIComponent(rid)}`,
            `${GHL_BASE}/calendars/events/${encodeURIComponent(rid)}`,
          ];
          let delOk = false;
          let delErr = '';
          for (const url of delPaths) {
            for (const Version of ['2021-04-15', '2021-07-28']) {
              const r = await fetchWithRetry(
                url,
                {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version },
                },
                0
              );
              if (r.ok || r.status === 404) {
                delOk = true;
                break;
              }
              const t = await r.text().catch(() => '');
              delErr = `${r.status} ${t}`.slice(0, 300);
            }
            if (delOk) break;
          }
          ghlApptResult.ok = delOk;
          ghlApptResult.detail = delErr || '';
          console.log('[BOOKING_DELETE_GHL_APPOINTMENT]', {
            rowId: rid,
            ok: delOk,
            detail: delErr ? delErr.slice(0, 200) : '',
          });
        }

        const bookingResetFields = [
          { id: FIELD_IDS.tijdafspraak, field_value: '', value: '' },
          { id: BOOKING_FORM_FIELD_IDS.tijdslot, field_value: '', value: '' },
          { id: BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum, field_value: '', value: '' },
          { id: BOOKING_FORM_FIELD_IDS.boeking_bevestigd_dagdeel, field_value: '', value: '' },
          { id: BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status, field_value: '', value: '' },
        ];
        const resetPut = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify({ customFields: bookingResetFields }),
          _allowPostRetry: false,
        });
        const resetOk = resetPut.ok;
        const resetTxt = resetOk ? '' : (await resetPut.text().catch(() => '')).slice(0, 400);
        console.log('[BOOKING_DELETE_CONTACT_RESET]', {
          contactId: cid,
          httpStatus: resetPut.status,
          ok: resetOk,
          detail: resetTxt ? resetTxt.slice(0, 200) : '',
        });
        if (!resetOk) {
          return res.status(502).json({
            error: 'Boekingsvelden op contact wissen mislukt',
            detail: resetTxt || undefined,
            redis: redisOut,
            ghlAppointment: ghlApptResult,
          });
        }

        console.log('[BOOKING_DELETE_DONE]', {
          contactId: cid,
          routeDate: dateNorm,
          synthetic,
          redis: redisOut,
          ghlAppointment: ghlApptResult,
        });

        return res.status(200).json({
          success: true,
          synthetic,
          redis: redisOut,
          ghlAppointment: ghlApptResult,
        });
      }

      case 'rescheduleAppointment': {
        const { ghlAppointmentId: rescId, newDate, newTime, type: rescType } = req.body;
        if (!rescId || !newDate || !newTime) {
          return res.status(400).json({ error: 'ghlAppointmentId, newDate en newTime vereist' });
        }
        const parts = String(newTime).split(':');
        const hNum = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
        const mNum = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
        const startD = amsterdamWallTimeToDate(newDate, hNum, mNum);
        if (!startD) return res.status(400).json({ error: 'Ongeldige datum/tijd' });
        const dur = ghlDurationMinutesForType(rescType) || 30;
        const startIso = startD.toISOString();
        const endIso = new Date(startD.getTime() + dur * 60 * 1000).toISOString();
        const result = await putCalendarStartEnd(rescId, startIso, endIso);
        if (!result.ok) {
          console.warn('[rescheduleAppointment] mislukt:', result.err);
          return res.status(500).json({ error: 'GHL herplannen mislukt', detail: result.err });
        }
        console.log('[rescheduleAppointment] bijgewerkt:', rescId, startIso);
        return res.status(200).json({ success: true });
      }

      case 'sendMorningMessages': {
        const { appointments } = req.body;
        for (const appt of appointments || []) {
          if (!appt.contactId) continue;
          const planned = String(appt.timeFrom || appt.timeTo || DEFAULT_BOOK_START_MORNING).trim();
          await fetchWithRetry(`${GHL_BASE}/contacts/${appt.contactId}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
            body: JSON.stringify({
              customFields: [{ id: FIELD_IDS.geplande_aankomst, field_value: planned }],
            }),
          });
          await pulseContactTag(appt.contactId, 'ochtend-melding', '[ghl sendMorningMessages]');
        }
        return res.status(200).json({ success: true, via: 'workflow-tag-ochtend-melding' });
      }

      case 'blockCalendarDay': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const date = normalizeYyyyMmDdInput(String(req.body?.date || ''));
        if (!date) return res.status(400).json({ error: 'date vereist (YYYY-MM-DD)' });
        const locationId = locConfigured;
        const calendarId = calConfigured;
        const titleRaw = req.body?.title;
        const title = titleRaw != null && String(titleRaw).trim() ? String(titleRaw).trim().slice(0, 120) : 'Dag geblokkeerd';
        const assignedUserId = await resolveBlockSlotAssignedUserId(
          GHL_BASE,
          GHL_API_KEY,
          locationId,
          calendarId
        );
        console.log(
          JSON.stringify({
            event: 'hk_block_calendar_day',
            stage: 'request',
            dateStr: date,
            calendarId,
            locationId,
            assignedUserId,
            usingDefaultBlockUser: assignedUserId === HK_DEFAULT_BLOCK_SLOT_USER_ID,
          })
        );
        const r = await postFullDayBlockSlot(GHL_BASE, {
          locationId,
          calendarId,
          dateStr: date,
          title,
          apiKey: GHL_API_KEY,
          assignedUserId,
        });
        if (r.error && !r.status) {
          return res.status(400).json({ error: r.error });
        }
        if (r.skipped) {
          invalidateAmsterdamDayGhlReadCachesForDate({
            locationId,
            calendarId,
            dateStr: date,
            blockSlotAssignedUserIds: [assignedUserId, HK_DEFAULT_BLOCK_SLOT_USER_ID],
            trigger: 'blockCalendarDay',
          });
          console.log(
            JSON.stringify({
              event: 'hk_block_calendar_day',
              outcome: 'skipped_already_blocked',
              dateStr: date,
              assignedUserId,
            })
          );
          return res.status(200).json({
            success: true,
            alreadyBlocked: true,
            message:
              typeof r.detail === 'string'
                ? r.detail
                : 'Kalender had al bloktijd op deze dag — geen nieuw blokslot geplaatst.',
          });
        }
        if (!r.ok) {
          const ghlDetail =
            typeof r.detail === 'string'
              ? r.detail
              : JSON.stringify(r.detail || r.data || {}).slice(0, 600);
          console.warn(
            '[blockCalendarDay] GHL:',
            r.status,
            r.versionTried,
            r.timeFormatTried,
            'calendarId+assignedUserId',
            ghlDetail
          );
          const tip =
            r.status === 422
              ? '422 = GHL-validatie. Controleer GHL_LOCATION_ID, GHL_CALENDAR_ID en een user (GHL_APPOINTMENT_ASSIGNED_USER_ID / GHL_BLOCK_SLOT_USER_ID of user gekoppeld aan de kalender in GHL).'
              : 'Controleer scopes (calendars/events.write). Zet GHL_APPOINTMENT_ASSIGNED_USER_ID of GHL_BLOCK_SLOT_USER_ID (zelfde user als op die kalender in GHL).';
          const detailTrim = String(ghlDetail || '').trim();
          const error =
            detailTrim.length > 0
              ? `${detailTrim.slice(0, 500)}${detailTrim.length > 500 ? '…' : ''} — ${tip}`
              : `GHL kon deze dag niet blokkeren (HTTP ${r.status}). ${tip}`;
          return res.status(502).json({
            error,
            ghlStatus: r.status,
            ghlDetail: detailTrim || undefined,
            ghlRaw:
              r.status === 422 && r.data && typeof r.data === 'object'
                ? JSON.stringify(r.data).slice(0, 900)
                : undefined,
          });
        }
        invalidateAmsterdamDayGhlReadCachesForDate({
          locationId,
          calendarId,
          dateStr: date,
          blockSlotAssignedUserIds: [assignedUserId, HK_DEFAULT_BLOCK_SLOT_USER_ID],
          trigger: 'blockCalendarDay',
        });
        console.log(
          JSON.stringify({
            event: 'hk_block_calendar_day',
            outcome: 'blocked',
            dateStr: date,
            assignedUserId,
            ghlHttpStatus: r.status,
          })
        );
        return res.status(200).json({ success: true, ...r.data });
      }

      case 'unblockCalendarDay': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const date = normalizeYyyyMmDdInput(String(req.body?.date || ''));
        if (!date) return res.status(400).json({ error: 'date vereist (YYYY-MM-DD)' });
        const loc = ghlLocationIdFromEnv();
        const cal = effectiveCalendarId();
        if (!GHL_API_KEY || !loc) {
          return res.status(500).json({ error: 'GHL-config ontbreekt op de server' });
        }

        const rawIds = Array.isArray(req.body?.ghlBlockEventIds) ? req.body.ghlBlockEventIds : [];
        let ids = [
          ...new Set(
            rawIds
              .map((x) => String(x || '').trim())
              .filter(Boolean)
              .filter((id) => !id.startsWith('hk_block_'))
          ),
        ];

        const idsFromClient = ids.length > 0;
        const blockUserId = await resolveBlockSlotAssignedUserId(GHL_BASE, GHL_API_KEY, loc, cal);
        console.log(
          JSON.stringify({
            event: 'hk_unblock_calendar_day',
            stage: 'request',
            dateStr: date,
            assignedUserId: blockUserId,
            usingDefaultBlockUser: blockUserId === HK_DEFAULT_BLOCK_SLOT_USER_ID,
          })
        );

        if (!ids.length) {
          /** Personal block-slots: GET blocked-slots met userId + merged calendar-queries. */
          ids = await listDeletableBlockIdsForAmsterdamDay(
            GHL_BASE,
            {
              locationId: loc,
              calendarId: cal,
              apiKey: GHL_API_KEY,
              assignedUserId: blockUserId,
            },
            date
          );
        }

        if (!ids.length) {
          return res.status(404).json({
            error:
              'Geen blokslot gevonden om te verwijderen. Ververs de dag of verwijder de blokkade handmatig in GHL.',
          });
        }

        const runDeletes = async (idList) => {
          const out = [];
          for (const bid of idList) {
            const r = await deleteGhlCalendarBlock(GHL_BASE, GHL_API_KEY, bid, loc);
            out.push({ id: bid, ok: r.ok, error: r.error });
          }
          return out;
        };

        let results = await runDeletes(ids);
        let anyOk = results.some((x) => x.ok);

        if (!anyOk && idsFromClient) {
          const discovered = await listDeletableBlockIdsForAmsterdamDay(
            GHL_BASE,
            {
              locationId: loc,
              calendarId: cal,
              apiKey: GHL_API_KEY,
              assignedUserId: blockUserId,
            },
            date
          );
          if (discovered.length) {
            ids = discovered;
            results = await runDeletes(ids);
            anyOk = results.some((x) => x.ok);
          }
        }
        if (!anyOk) {
          return res.status(502).json({
            error: results.map((x) => `${x.id}: ${x.error || 'mislukt'}`).join('; ').slice(0, 600),
            results,
          });
        }
        const partial = results.some((x) => !x.ok);
        const deletedN = results.filter((x) => x.ok).length;
        invalidateAmsterdamDayGhlReadCachesForDate({
          locationId: loc,
          calendarId: cal,
          dateStr: date,
          blockSlotAssignedUserIds: [blockUserId, HK_DEFAULT_BLOCK_SLOT_USER_ID],
          trigger: 'unblockCalendarDay',
        });
        console.log(
          JSON.stringify({
            event: 'hk_unblock_calendar_day',
            outcome: 'success',
            dateStr: date,
            assignedUserId: blockUserId,
            deleted: deletedN,
            partial,
          })
        );
        return res.status(200).json({
          success: true,
          deleted: deletedN,
          partial,
          results,
        });
      }

      /**
       * Bulk: alle blokslots in een datumbereik verwijderen (blocked-slots API → DELETE).
       * Alleen user `daan` + exacte confirm-string. Geen toegang tot GHL vanuit Cursor — jij triggert dit na deploy.
       */
      case 'bulkDeleteBlockedSlots': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const token = req.headers['x-hk-auth'];
        const sess = verifySessionToken(token);
        if (!sess || String(sess.user || '').toLowerCase() !== 'daan') {
          return res.status(403).json({
            error: 'Alleen ingelogd als **daan** kun je bulk blokslots verwijderen.',
          });
        }
        if (String(req.body?.confirm || '').trim() !== 'VERWIJDER_ALLE_BLOKJES') {
          return res.status(400).json({
            error:
              'Zet JSON body.confirm exact op: VERWIJDER_ALLE_BLOKJES (veiligheid tegen per ongeluk aanroepen).',
          });
        }
        const loc = ghlLocationIdFromEnv();
        if (!loc || !GHL_API_KEY) {
          return res.status(500).json({ error: 'GHL_LOCATION_ID of GHL_API_KEY ontbreekt' });
        }
        const cal = effectiveCalendarId();

        let startDate = normalizeYyyyMmDdInput(String(req.body?.startDate || ''));
        let endDate = normalizeYyyyMmDdInput(String(req.body?.endDate || ''));
        if (!startDate || !endDate) {
          const today = formatYyyyMmDdInAmsterdam(new Date());
          if (!today) return res.status(500).json({ error: 'Kon datum niet bepalen' });
          /** Standaard: ~3 weken terug + 12 weken vooruit (dubbele blokken opruimen). */
          startDate = addAmsterdamCalendarDays(today, -21) || today;
          endDate = addAmsterdamCalendarDays(today, 84) || today;
        }
        const sb = amsterdamCalendarDayBoundsMs(startDate);
        const eb = amsterdamCalendarDayBoundsMs(endDate);
        if (!sb || !eb) return res.status(400).json({ error: 'Ongeldige startDate of endDate' });
        const startMs = sb.startMs;
        const endMs = eb.endMs;
        const maxSpanMs = 600 * 24 * 60 * 60 * 1000;
        if (endMs - startMs > maxSpanMs) {
          return res.status(400).json({
            error:
              'Datumbereik te groot (max 600 dagen per keer). Geef kortere startDate/endDate of voer meerdere keren uit.',
          });
        }

        const bulkBlockUserId = await resolveBlockSlotAssignedUserId(GHL_BASE, GHL_API_KEY, loc, cal);
        const allIds = await listDeletableBlockIdsForMsRange(GHL_BASE, {
          locationId: loc,
          calendarId: cal,
          apiKey: GHL_API_KEY,
          startMs,
          endMs,
          assignedUserId: bulkBlockUserId,
        });
        const MAX_PER_RUN = 300;
        const truncated = allIds.length > MAX_PER_RUN;
        const ids = truncated ? allIds.slice(0, MAX_PER_RUN) : allIds;

        if (!ids.length) {
          return res.status(200).json({
            success: true,
            deleted: 0,
            attempted: 0,
            message:
              'Geen blokslots in blocked-slots voor dit bereik. (Staat het in GHL als sync/read-only, dan ziet de API ze soms niet — GHL support of bronagenda.)',
            range: { startDate, endDate },
          });
        }

        const results = [];
        for (const bid of ids) {
          const dr = await deleteGhlCalendarBlock(GHL_BASE, GHL_API_KEY, bid, loc);
          results.push({ id: bid, ok: dr.ok, error: dr.error });
          await new Promise((r) => setTimeout(r, 75));
        }
        const deleted = results.filter((x) => x.ok).length;
        const failed = results.filter((x) => !x.ok).map((x) => ({ id: x.id, error: x.error }));
        console.warn(
          '[bulkDeleteBlockedSlots]',
          sess.user,
          { startDate, endDate },
          'deleted',
          deleted,
          'failed',
          failed.length
        );
        return res.status(200).json({
          success: true,
          deleted,
          attempted: ids.length,
          totalFound: allIds.length,
          truncated,
          failed: failed.slice(0, 40),
          range: { startDate, endDate },
        });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    console.error('[ghl] onverwachte fout:', err.message);
    await sendErrorNotification(
      `GHL API fout: ${action}`,
      `Fout: ${err.message}\n\nStack:\n${err.stack}`
    );
    return res.status(500).json({ error: err.message });
  }
}

async function addTag(contactId, tag) {
  await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ tags: [tag] })
  });
}

async function updateOpportunityStage(contactId, stage) {
  const res = await fetchWithRetry(`${GHL_BASE}/opportunities/search?contact_id=${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await res.json();
  const opp = data?.opportunities?.[0];
  if (!opp) return;
  await fetchWithRetry(`${GHL_BASE}/opportunities/${opp.id}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ status: stage })
  });
}
