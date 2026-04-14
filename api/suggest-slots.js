// api/suggest-slots.js
// Klantvoorstellen: datum + dagdeel (ochtend/middag) via lib/block-capacity-offers.js — geen GHL free-slots in de handler.
// Legacy: functies voor GET …/free-slots staan hier nog; worden door deze route niet meer aangeroepen.
// Route-fit (geocode) blijft optioneel voor sortering.

import { normalizeWorkType } from '../lib/booking-blocks.js';
import {
  blockDisplayLabels,
  evaluateBlockOffer,
  isEventInCustomerBlock,
} from '../lib/block-capacity-offers.js';
import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  amsterdamWeekdaySun0,
  formatYyyyMmDdInAmsterdam,
  hourInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import { DAYPART_SPLIT_HOUR } from '../lib/planning-work-hours.js';
import { availabilityDebugEnabled, logAvailability } from '../lib/availability-debug.js';
import {
  isCustomerBookingBlockedOnAmsterdamDate,
  markBlockLikeOnCalendarEvents,
  resolveBlockSlotAssignedUserId,
} from '../lib/ghl-calendar-blocks.js';
import {
  cachedFetchBlockedSlotsAsEvents,
  cachedFetchCalendarEventsForDay,
  cachedListConfirmedSyntheticEventsForDate,
} from '../lib/amsterdam-day-read-cache.js';
import { readCanonicalAddressLine } from '../lib/ghl-contact-canonical.js';
import {
  GHL_CONFIG_MISSING_MSG,
  ghlCalendarIdFromEnv,
  ghlLocationIdFromEnv,
  stripGhlEnvId,
} from '../lib/ghl-env-ids.js';
import {
  buildProposalScanSchedule,
  effectiveMaxOptions,
  parseProposalConstraints,
  proposalBlocksToEvaluate,
  proposalConstraintsPassCandidate,
} from '../lib/proposal-constraints.js';
import { rankProposalCandidates } from '../lib/proposal-ranking.js';
import { isGeoValid } from '../lib/geo-gate.js';
import { geocode, geocodeEvents } from '../lib/geo-utils.js';
import { fetchWithRetry } from '../lib/retry.js';
const GHL_API_KEY = process.env.GHL_API_KEY;
const PROPOSAL_CLUSTERING_FIRST = String(process.env.PROPOSAL_CLUSTERING_FIRST || '').toLowerCase() === 'true';

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GHL rate-limits (429); wacht Retry-After of exponentieel. */
async function ghlFetchWith429Backoff(url, headers, max429Attempts = 6) {
  for (let a = 0; a < max429Attempts; a++) {
    const r = await fetch(url, { headers });
    if (r.status !== 429) return r;
    if (a === max429Attempts - 1) return r;
    const ra = r.headers.get('retry-after');
    let waitMs = ra ? parseInt(ra, 10) * 1000 : 1000 * Math.pow(2, a);
    if (!Number.isFinite(waitMs) || waitMs < 0) waitMs = 1000 * Math.pow(2, a);
    waitMs = Math.min(waitMs, 60_000);
    console.warn(`[suggest-slots] free-slots 429 — wacht ${waitMs}ms (${a + 1}/${max429Attempts})`);
    await sleepMs(waitMs);
  }
  return fetch(url, { headers });
}
const GHL_BASE = 'https://services.leadconnectorhq.com';

/** 3 weken vooruit (21 dagen). */
const FREE_SLOTS_DAYS = 21;

const FIELD_IDS = {
  type_onderhoud: 'EXSQmlt7BqkXJMs8F3Qk',
};

function getField(contact, fieldId) {
  if (!contact?.customFields) return '';
  const fid = String(fieldId);
  const f = contact.customFields.find(
    (x) => x.id === fid || x.fieldId === fid || x.customFieldId === fid
  );
  const raw = f?.value ?? f?.field_value;
  return raw != null && raw !== '' ? String(raw) : '';
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestDistanceKm(newCoord, existingCoords) {
  if (!existingCoords.length) return null;
  return Math.min(...existingCoords.map((c) => haversine(newCoord.lat, newCoord.lng, c.lat, c.lng)));
}

/** Velden die GHL soms naast datum-keys op root zet (niet als slot-dagen tellen). */
const GHL_FREE_SLOTS_META_KEYS = new Set([
  'traceId',
  'success',
  'message',
  'error',
  'statusCode',
  'meta',
  'version',
  'warnings',
]);

/**
 * Platte map { "YYYY-MM-DD": Slot[] } zoals in marketplace-docs beschreven.
 */
function filterAsDateKeyedSlotMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GHL_FREE_SLOTS_META_KEYS.has(k)) continue;
    if (!dateRe.test(k)) continue;
    let arr = null;
    if (Array.isArray(v)) arr = v;
    else if (v && typeof v === 'object') {
      if (Array.isArray(v.slots)) arr = v.slots;
      else if (Array.isArray(v.freeSlots)) arr = v.freeSlots;
      else if (Array.isArray(v.availableSlots)) arr = v.availableSlots;
    }
    if (arr) out[k] = arr;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** GHL free-slots payload → object met datum-keys (of één array onder _all). */
function extractSlotsObject(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.slots)) return { _all: data.slots };
  const inner =
    data.slots ?? data.data?.slots ?? data.result ?? data.freeSlots ?? data.availability ?? data.data?.result;
  if (inner != null && typeof inner === 'object') {
    if (Array.isArray(inner)) return { _all: inner };
    const byDateInner = filterAsDateKeyedSlotMap(inner);
    if (byDateInner) return byDateInner;
    if (inner.data && typeof inner.data === 'object') {
      const nested = filterAsDateKeyedSlotMap(inner.data);
      if (nested) return nested;
    }
    /** Oud gedrag: geneste object zonder datum-keys (bijv. leeg { slots: {} }) */
    if (!Array.isArray(inner) && Object.keys(inner).length > 0) {
      const onlyMeta = Object.keys(inner).every((k) => GHL_FREE_SLOTS_META_KEYS.has(k));
      if (!onlyMeta) return inner;
    }
  }
  const rootMap = filterAsDateKeyedSlotMap(data);
  if (rootMap) return rootMap;
  if (data.data && typeof data.data === 'object') {
    const inData = filterAsDateKeyedSlotMap(data.data);
    if (inData) return inData;
  }
  return null;
}

/** Expliciet lege slots van GHL (200) — geen 502. */
function isEmptyFreeSlotsSuccess(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.error || (typeof data.statusCode === 'number' && data.statusCode >= 400)) return false;
  const s = data.slots;
  if (s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 0) return true;
  return false;
}

/** Zelfde ms-normalisatie voor losse timestamps en voor velden op een slot-object. */
function coercedEpochMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? Math.round(raw * 1000) : raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return NaN;
      return n < 1e12 ? Math.round(n * 1000) : n;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

/**
 * GHL free-slots levert soms per dag een array van ISO-strings of unix-getallen;
 * soms objecten met bookingStartTime of genest calendarEvent — oude code las alleen { startTime, … }.
 */
function slotStartMs(slot, depth = 0) {
  if (slot == null || depth > 3) return NaN;
  if (typeof slot === 'string' || typeof slot === 'number') return coercedEpochMs(slot);
  if (typeof slot !== 'object') return NaN;
  const raw =
    slot.startTime ??
    slot.start ??
    slot.from ??
    slot.bookingStartTime ??
    slot.booking_start_time ??
    slot.slotTime ??
    slot.dateTime ??
    slot.time ??
    slot.startDateTime;
  const direct = coercedEpochMs(raw);
  if (!Number.isNaN(direct)) return direct;
  const nested =
    slot.calendarEvent || slot.calendar_event || slot.event || slot.appointment;
  if (nested && typeof nested === 'object') return slotStartMs(nested, depth + 1);
  return NaN;
}

/**
 * Tel vrije slots per Amsterdam-kalenderdag en ochtend / middag (split op DAYPART_SPLIT_HOUR).
 */
function pickFirstFreeSlotSample(slotsObj) {
  if (!slotsObj || typeof slotsObj !== 'object') return null;
  for (const [bucketDateKey, v] of Object.entries(slotsObj)) {
    const arr = Array.isArray(v) ? v : [];
    if (arr.length === 0) continue;
    const raw = arr[0];
    return {
      bucketDateKey,
      raw,
      slotJsType: raw === null ? 'null' : typeof raw,
      topLevelKeys:
        raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).slice(0, 20) : [],
    };
  }
  return null;
}

function aggregateFreeSlotsByAmsterdamDay(slotsObj) {
  const out = new Map();
  for (const slots of Object.values(slotsObj)) {
    const arr = Array.isArray(slots) ? slots : [];
    for (const slot of arr) {
      const ms = slotStartMs(slot);
      if (Number.isNaN(ms)) continue;
      const dateStr = formatYyyyMmDdInAmsterdam(new Date(ms));
      if (!dateStr) continue;
      const part = out.get(dateStr) || { morning: 0, afternoon: 0 };
      const h = hourInAmsterdam(ms);
      if (h < DAYPART_SPLIT_HOUR) part.morning += 1;
      else part.afternoon += 1;
      out.set(dateStr, part);
    }
  }
  return out;
}

/**
 * GET /calendars/:id/free-slots — GHL gebruikt querynamen startDate/endDate maar met **Unix-ms**
 * (niet YYYY-MM-DD), zie marketplace / curl-voorbeelden.
 */
async function fetchGhlFreeSlots({ calendarId, locationId, startMs, endMs, apiKey }) {
  const baseQs = new URLSearchParams({
    startDate: String(startMs),
    endDate: String(endMs),
    timezone: 'Europe/Amsterdam',
  });
  const withLoc = new URLSearchParams(baseQs);
  if (locationId) withLoc.set('locationId', locationId);

  const encCal = encodeURIComponent(calendarId);
  /**
   * Alleen GET /calendars/:calendarId/free-slots (marketplace).
   * Nooit GET /calendars/free-slots?calendarId=… — GHL routeert dat als :calendarId = "free-slots"
   * → 400 "Calendar not found for id: free-slots".
   */
  const userIdOpt = stripGhlEnvId(
    process.env.GHL_FREE_SLOTS_USER_ID ||
      process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID ||
      process.env.GHL_BLOCK_SLOT_USER_ID
  );
  const withLocUser = new URLSearchParams(withLoc);
  if (userIdOpt) withLocUser.set('userId', userIdOpt);

  const urlAttempts = [
    `${GHL_BASE}/calendars/${encCal}/free-slots?${withLoc}`,
    ...(userIdOpt ? [`${GHL_BASE}/calendars/${encCal}/free-slots?${withLocUser}`] : []),
    `${GHL_BASE}/calendars/${encCal}/free-slots?${baseQs}`,
  ];
  if (availabilityDebugEnabled()) {
    logAvailability('suggest_free_slots_ghl_request_plan', {
      base: GHL_BASE,
      calendarId,
      locationId: locationId || null,
      startDateMs: startMs,
      endDateMs: endMs,
      timezone: 'Europe/Amsterdam',
      userIdParamSet: !!userIdOpt,
      urlAttemptOrder: urlAttempts.map((u) => u.split('?')[0]),
    });
  }
  /** Eerst één API-versie; tweede alleen bij mislukking (minder 429-risico). */
  const versions = ['2021-04-15', '2021-07-28'];
  let lastErr = '';
  const seen = new Set();
  for (const url of urlAttempts) {
    if (seen.has(url)) continue;
    seen.add(url);
    for (const Version of versions) {
      const r = await ghlFetchWith429Backoff(url, {
        Authorization: `Bearer ${apiKey}`,
        Version,
      });
      const txt = await r.text().catch(() => '');
      if (!r.ok) {
        lastErr = `${r.status} ${txt.slice(0, 200)}`;
        if (availabilityDebugEnabled()) {
          logAvailability('suggest_free_slots_ghl_http_error', {
            httpStatus: r.status,
            apiVersion: Version,
            bodyPreview: txt.slice(0, 300),
          });
        }
        continue;
      }
      let data;
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        lastErr = 'JSON parse';
        if (availabilityDebugEnabled()) {
          logAvailability('suggest_free_slots_ghl_json_error', {
            apiVersion: Version,
            textPreview: txt.slice(0, 200),
          });
        }
        continue;
      }
      const slotsObj = extractSlotsObject(data);
      if (slotsObj) {
        if (availabilityDebugEnabled()) {
          const perDay = Object.fromEntries(
            Object.entries(slotsObj).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
          );
          logAvailability('suggest_free_slots_ghl_success', {
            httpStatus: r.status,
            apiVersion: Version,
            requestPath: `/calendars/{id}/free-slots`,
            fullUrl: url.split('?')[0] + '?[startDate,endDate,timezone,locationId?,userId?]',
            slotShapeKeys: Object.keys(data || {}).slice(0, 20),
            parsedDateKeys: Object.keys(slotsObj).filter((k) => k !== '_all'),
            slotCountsByDateKey: perDay,
          });
        }
        return { ok: true, data, slotsObj };
      }
      if (isEmptyFreeSlotsSuccess(data)) {
        if (availabilityDebugEnabled()) {
          logAvailability('suggest_free_slots_ghl_empty_ok', {
            httpStatus: r.status,
            apiVersion: Version,
            note: 'GHL 200 with empty slots object — treated as zero availability',
          });
        }
        return { ok: true, data, slotsObj: {} };
      }
      const keys = Object.keys(data).slice(0, 14).join(', ');
      lastErr = `Geen slots-object in response (top keys: ${keys || '—'})`;
    }
  }
  if (availabilityDebugEnabled()) {
    logAvailability('suggest_free_slots_ghl_failed', {
      lastError: lastErr || 'free-slots mislukt',
      attempts: urlAttempts.length,
    });
  }
  return { ok: false, error: lastErr || 'free-slots mislukt' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const reqT0 = Date.now();
  const perf = {
    route: 'suggest-slots',
    ghl_calendar_fetch_sum_ms: 0,
    blocked_slots_fetch_sum_ms: 0,
    redis_synthetic_sum_ms: 0,
    day_blocked_check_sum_ms: 0,
    evaluate_block_offer_sum_ms: 0,
    geocode_route_fit_sum_ms: 0,
    contact_resolve_day_ms: 0,
    contact_fetch_ms: 0,
    geocode_address_ms: 0,
    map_sort_slice_ms: 0,
  };

  try {
    const body = req.method === 'POST' ? req.body || {} : {};
    const q = req.method === 'POST' ? body : req.query;
    const {
      contactId,
      address: addressParam,
      name: nameParam,
      phone: phoneParam,
      type: typeQ,
      workType: workTypeQ,
      proposalConstraints: proposalConstraintsRaw,
    } = q;
    const spoedMode = req.query?.spoed === 'true' || body?.spoedMode === true;
    const proposalConstraints = parseProposalConstraints(proposalConstraintsRaw);

    if (availabilityDebugEnabled()) {
      logAvailability('suggest_slots_raw_input', {
        method: req.method,
        hasContactId: !!contactId,
        hasName: !!(nameParam && String(nameParam).trim()),
        hasPhone: !!(phoneParam && String(phoneParam).trim()),
        hasAddress: !!(addressParam && String(addressParam).trim()),
        type: typeQ || null,
        workType: workTypeQ || null,
      });
    }

    if (!contactId && !addressParam && !nameParam && !phoneParam) {
      return res.status(400).json({ error: 'contactId, address, name of phone vereist' });
    }

    if (!GHL_API_KEY) {
      return res.status(500).json({ success: false, error: 'GHL API key ontbreekt' });
    }

    const locId = ghlLocationIdFromEnv();
    const calId = ghlCalendarIdFromEnv();
    if (!locId || !calId) {
      return res.status(503).json({ success: false, error: GHL_CONFIG_MISSING_MSG });
    }

    let resolvedContactId = contactId || null;
    let contactName = nameParam || '';
    let contactPhone = phoneParam || '';
    let address = addressParam || '';
    /** Hergebruik contactpayload voor workType i.p.v. extra GET. */
    let cachedContact = null;

    const tContact0 = Date.now();
    if (resolvedContactId) {
      try {
        const cr = await fetch(`${GHL_BASE}/contacts/${resolvedContactId}`, {
          headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
        });
        if (cr.ok) {
          const cd = await cr.json();
          const contact = cd?.contact || cd;
          cachedContact = contact;
          contactName = contact.firstName
            ? `${contact.firstName} ${contact.lastName || ''}`.trim()
            : contact.name || contactName;
          contactPhone = contact.phone || contactPhone;
          if (!address) {
            address = readCanonicalAddressLine(contact) || contact.address1 || '';
          }
        }
      } catch {}
    } else {
      const searchPhone = (phoneParam || '').replace(/\s/g, '');
      if (searchPhone) {
        try {
          const sr = await fetch(
            `${GHL_BASE}/contacts/search/duplicate?locationId=${locId}&number=${encodeURIComponent(searchPhone)}`,
            { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
          );
          if (sr.ok) {
            const sd = await sr.json();
            const c = sd?.contact;
            if (c?.id) {
              resolvedContactId = c.id;
              cachedContact = c;
              contactName = c.firstName
                ? `${c.firstName} ${c.lastName || ''}`.trim()
                : c.name || contactName;
              contactPhone = c.phone || contactPhone;
              if (!address) {
                address = readCanonicalAddressLine(c) || c.address1 || '';
              }
            }
          }
        } catch {}
      }
      if (!resolvedContactId && nameParam) {
        try {
          const nr = await fetch(
            `${GHL_BASE}/contacts/?locationId=${locId}&query=${encodeURIComponent(nameParam)}&limit=1`,
            { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
          );
          if (nr.ok) {
            const nd = await nr.json();
            const c = nd?.contacts?.[0];
            if (c?.id) {
              resolvedContactId = c.id;
              cachedContact = c;
              contactName = c.firstName
                ? `${c.firstName} ${c.lastName || ''}`.trim()
                : c.name || contactName;
              contactPhone = c.phone || contactPhone;
              if (!address) {
                address = readCanonicalAddressLine(c) || c.address1 || '';
              }
            }
          }
        } catch {}
      }
    }

    perf.contact_fetch_ms = Date.now() - tContact0;

    let workType = normalizeWorkType(workTypeQ || typeQ || '');
    const tWorkType0 = Date.now();
    if (!workTypeQ && !typeQ && resolvedContactId) {
      if (cachedContact) {
        workType = normalizeWorkType(getField(cachedContact, FIELD_IDS.type_onderhoud));
      } else {
        try {
          const cr = await fetch(`${GHL_BASE}/contacts/${resolvedContactId}`, {
            headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
          });
          if (cr.ok) {
            const cd = await cr.json();
            const c = cd?.contact || cd;
            workType = normalizeWorkType(getField(c, FIELD_IDS.type_onderhoud));
          }
        } catch {}
      }
    }
    perf.contact_fetch_ms += Date.now() - tWorkType0;

    const startDate = addAmsterdamCalendarDays(formatYyyyMmDdInAmsterdam(new Date()), 1);
    if (!startDate) return res.status(500).json({ error: 'Datumfout' });
    const endDate = addAmsterdamCalendarDays(startDate, FREE_SLOTS_DAYS - 1);
    if (!endDate) return res.status(500).json({ error: 'Datumfout eind' });

    const startBounds = amsterdamCalendarDayBoundsMs(startDate);
    const endBounds = amsterdamCalendarDayBoundsMs(endDate);
    if (!startBounds || !endBounds) {
      return res.status(500).json({ error: 'Kon ms-bereik voor free-slots niet bepalen' });
    }

    if (availabilityDebugEnabled()) {
      logAvailability('suggest_slots_resolved_before_eval', {
        resolvedContactId: resolvedContactId || null,
        workType,
        locationId: locId,
        calendarId: calId,
        windowAmsterdamYmd: [startDate, endDate],
        windowMs: { start: startBounds.startMs, end: endBounds.endMs },
        timeZone: 'Europe/Amsterdam',
        geocodeOk: !!address,
        engine: 'block-capacity-offers',
      });
    }

    const blockSlotUserId = await resolveBlockSlotAssignedUserId(GHL_BASE, GHL_API_KEY, locId, calId);

    const availabilityCtx = {
      locationId: locId,
      calendarId: calId,
      apiKey: GHL_API_KEY,
      assignedUserId: blockSlotUserId,
    };

    const dayLoadCache = new Map();
    /** Zelfde data als voorheen: merged GHL + blocked + Redis-synthetisch; per dateStr één in-flight bundle. */
    function loadDayBundle(dateStr) {
      if (dayLoadCache.has(dateStr)) return dayLoadCache.get(dateStr);
      const p = (async () => {
        const bounds = amsterdamCalendarDayBoundsMs(dateStr);
        if (!bounds) {
          let resvSynthetic = [];
          try {
            const tRedis = Date.now();
            resvSynthetic = await cachedListConfirmedSyntheticEventsForDate(dateStr);
            perf.redis_synthetic_sum_ms += Date.now() - tRedis;
          } catch (e) {
            console.warn('[suggest-slots] block reservations:', e?.message || e);
          }
          const mergedEvents = [];
          const eventsForCapacity =
            resvSynthetic.length > 0 ? [...mergedEvents, ...resvSynthetic] : mergedEvents;
          return { mergedEvents, eventsForCapacity };
        }

        const tCal = Date.now();
        const calEv = await cachedFetchCalendarEventsForDay(dateStr, {
          base: GHL_BASE,
          locationId: locId,
          calendarId: calId,
          apiKey: GHL_API_KEY,
        });
        perf.ghl_calendar_fetch_sum_ms += Date.now() - tCal;
        if (calEv === null) return null;

        const arr = Array.isArray(calEv) ? calEv : [];
        const [blockedMerged, resvSynthetic] = await Promise.all([
          (async () => {
            const tBlk = Date.now();
            const b = await cachedFetchBlockedSlotsAsEvents(
              GHL_BASE,
              {
                locationId: locId,
                calendarId: calId,
                apiKey: GHL_API_KEY,
                assignedUserId: blockSlotUserId,
              },
              bounds
            );
            perf.blocked_slots_fetch_sum_ms += Date.now() - tBlk;
            return b;
          })(),
          (async () => {
            try {
              const tRedis = Date.now();
              const r = await cachedListConfirmedSyntheticEventsForDate(dateStr);
              perf.redis_synthetic_sum_ms += Date.now() - tRedis;
              return r;
            } catch (e) {
              console.warn('[suggest-slots] block reservations:', e?.message || e);
              return [];
            }
          })(),
        ]);

        const merged = arr.concat(Array.isArray(blockedMerged) ? blockedMerged : []);
        markBlockLikeOnCalendarEvents(merged);
        const syn = Array.isArray(resvSynthetic) ? resvSynthetic : [];
        const eventsForCapacity = syn.length > 0 ? [...merged, ...syn] : merged;
        return { mergedEvents: merged, eventsForCapacity };
      })();
      dayLoadCache.set(dateStr, p);
      return p;
    }

    const candidates = [];
    const dbg = availabilityDebugEnabled();
    const suggestTrace = dbg
      ? { flow: 'suggest-slots', window: [startDate, endDate], timeZone: 'Europe/Amsterdam', days: [] }
      : null;

    const schedule = buildProposalScanSchedule({
      startDate,
      defaultHorizonDays: FREE_SLOTS_DAYS,
      proposalConstraints,
    });
    const blocksToTry = proposalBlocksToEvaluate(proposalConstraints);
    const maxSuggest = effectiveMaxOptions(proposalConstraints, 2, 2);
    const scanCandidateTarget = maxSuggest + 4;

    const processSuggestDay = async (cursor, i, useSpoedMode = false) => {
      const geocodeCache = new Map();
      async function cachedGeocode(addressLine) {
        const key = String(addressLine || '').trim();
        if (!key) return null;
        if (geocodeCache.has(key)) return geocodeCache.get(key);
        const coord = await geocode(key);
        geocodeCache.set(key, coord ?? null);
        return geocodeCache.get(key);
      }

      const tGeoAddr0 = Date.now();
      const newCoord = address ? await cachedGeocode(address) : null;
      perf.geocode_address_ms += Date.now() - tGeoAddr0;

      try {
        const tDayBlk = Date.now();
        const dayBlk = await isCustomerBookingBlockedOnAmsterdamDate(GHL_BASE, availabilityCtx, cursor);
        perf.day_blocked_check_sum_ms += Date.now() - tDayBlk;
        if (dayBlk) {
          if (suggestTrace) suggestTrace.days.push({ dateStr: cursor, outcome: 'excluded', why: 'day_blocked' });
          return 'ok';
        }
      } catch (e) {
        console.error('[suggest-slots] availability check:', e?.message || e);
        return 'availability_error';
      }

      let dayBundle;
      try {
        dayBundle = await loadDayBundle(cursor);
      } catch (e) {
        console.error('[suggest-slots] calendar events:', e?.message || e);
        return 'calendar_error';
      }
      if (dayBundle === null) return 'calendar_null';

      const { eventsForCapacity } = dayBundle;

      const dayBounds = amsterdamCalendarDayBoundsMs(cursor);
      const dateLabel = dayBounds
        ? new Date(dayBounds.startMs + 12 * 3600000).toLocaleDateString('nl-NL', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'Europe/Amsterdam',
          })
        : cursor;

      let addedForDay = 0;
      for (const block of blocksToTry) {
        if (!proposalConstraintsPassCandidate(cursor, block, proposalConstraints)) continue;
        const tEval = Date.now();
        const evaluation = evaluateBlockOffer({
          dateStr: cursor,
          block,
          workType,
          events: eventsForCapacity,
          dayBlocked: false,
        });
        perf.evaluate_block_offer_sum_ms += Date.now() - tEval;

        if (!evaluation.eligible) {
          if (suggestTrace) {
            suggestTrace.days.push({
              dateStr: cursor,
              outcome: 'excluded',
              why: evaluation.reason || 'not_eligible',
              part: block,
              workType,
            });
          }
          continue;
        }

        const labels = blockDisplayLabels(block);
        const maxB = evaluation.state.maxCustomersInBlock;
        const slotsLeft = Math.max(0, maxB - evaluation.state.blockCustomerCount);
        const existingCount = evaluation.state.blockCustomerCount;

        const evalScore = Number(evaluation.score ?? 0);
        let legacyScore = evalScore + i * 0.02;
        let nearestDistanceForCandidate = null;
        const customerEvents = eventsForCapacity.filter((e) => !e._hkGhlBlockSlot);
        const morningEvents = customerEvents.filter((e) => isEventInCustomerBlock(e, 'morning'));
        const afternoonEvents = customerEvents.filter((e) => isEventInCustomerBlock(e, 'afternoon'));
        const uniqueCids = [
          ...new Set(
            customerEvents
              .map((e) => String(e.contactId || e.contact_id || '').trim())
              .filter(Boolean)
          ),
        ];
        const tContactResolve0 = Date.now();
        const contactResults = await Promise.all(
          uniqueCids.map(async (cid) => {
            try {
              const r = await fetchWithRetry(`${GHL_BASE}/contacts/${cid}`, {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${GHL_API_KEY}`,
                  'Content-Type': 'application/json',
                  Version: '2021-04-15',
                },
              });
              const d = await r.json();
              return { cid, contact: d.contact ?? d ?? null };
            } catch {
              return { cid, contact: null };
            }
          })
        );
        const eventContactMap = {};
        for (const { cid, contact } of contactResults) {
          if (contact) {
            eventContactMap[cid] = readCanonicalAddressLine(contact) || contact.address1 || '';
          }
        }
        perf.contact_resolve_day_ms = (perf.contact_resolve_day_ms ?? 0) + (Date.now() - tContactResolve0);
        const [morningCoords, afternoonCoords] = await Promise.all([
          geocodeEvents(
            morningEvents.map((e) => ({
              ...e,
              address: e.address || eventContactMap[String(e.contactId || e.contact_id || '')] || '',
            })),
            cachedGeocode
          ),
          geocodeEvents(
            afternoonEvents.map((e) => ({
              ...e,
              address: e.address || eventContactMap[String(e.contactId || e.contact_id || '')] || '',
            })),
            cachedGeocode
          ),
        ]);
        const geoCheck = isGeoValid(
          newCoord,
          {
            morning: morningCoords,
            afternoon: afternoonCoords,
            targetBlock: block,
          },
          useSpoedMode
        );
        if (!geoCheck.valid) {
          console.info(
            `[geo-gate] Skipped ${cursor} ${block} for contact ${resolvedContactId || 'unknown'}: ` +
              `${geoCheck.reason} (coord: ${JSON.stringify(newCoord)})`
          );
          continue;
        }

        if (newCoord) {
          const blockEvents = block === 'morning' ? morningEvents : afternoonEvents;
          const tRg = Date.now();
          const existingCoords = block === 'morning' ? morningCoords : afternoonCoords;
          perf.geocode_route_fit_sum_ms += Date.now() - tRg;
          nearestDistanceForCandidate = nearestDistanceKm(newCoord, existingCoords);
          if (Number.isFinite(nearestDistanceForCandidate)) {
            legacyScore += nearestDistanceForCandidate * (1 + blockEvents.length / Math.max(1, maxB)) + i * 0.01;
          }
        }

        candidates.push({
          dateStr: cursor,
          dateLabel,
          block,
          existingCount,
          score: legacyScore,
          legacyScore,
          evalScore,
          nearestDistanceKm: nearestDistanceForCandidate,
          timeLabel: labels.slotLabelSpace,
          blockLabel: labels.blockLabelNl,
          slotsLeft,
        });
        addedForDay++;
      }
      if (suggestTrace && addedForDay === 0) {
        suggestTrace.days.push({
          dateStr: cursor,
          outcome: 'excluded',
          why: 'no_block_eligible_for_work_type',
        });
      }
      return 'ok';
    };

    if (schedule.kind === 'list') {
      for (let j = 0; j < schedule.dates.length; j++) {
        const cursor = schedule.dates[j];
        const status = await processSuggestDay(cursor, j, spoedMode);
        if (status === 'availability_error') {
          return res.status(503).json({
            success: false,
            error: 'Agenda-blokkades tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }
        if (status === 'calendar_error') {
          return res.status(503).json({
            success: false,
            error: 'Kalender-events tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }
        if (status === 'calendar_null') {
          return res.status(503).json({
            success: false,
            error: 'Kalender-events tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }
        if (candidates.length >= scanCandidateTarget) break;
      }
    } else {
      let cursor = schedule.start;
      for (let i = 0; i < schedule.horizon; i++) {
        if (!cursor) break;
        const dow = amsterdamWeekdaySun0(cursor);
        if (dow === 0 || dow === 6) {
          if (suggestTrace) suggestTrace.days.push({ dateStr: cursor, outcome: 'excluded', why: 'weekend' });
          cursor = addAmsterdamCalendarDays(cursor, 1);
          continue;
        }
        const status = await processSuggestDay(cursor, i, spoedMode);
        if (status === 'availability_error') {
          return res.status(503).json({
            success: false,
            error: 'Agenda-blokkades tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }
        if (status === 'calendar_error') {
          return res.status(503).json({
            success: false,
            error: 'Kalender-events tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }
        if (status === 'calendar_null') {
          return res.status(503).json({
            success: false,
            error: 'Kalender-events tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }
        cursor = addAmsterdamCalendarDays(cursor, 1);
        if (candidates.length >= scanCandidateTarget) break;
      }
    }

    const tMap0 = Date.now();
    const ranking = rankProposalCandidates({
      candidates,
      nowDateStr: startDate,
      enableClusteringFirst: PROPOSAL_CLUSTERING_FIRST,
      horizonDays: 14,
      tierAMinutes: 15,
      tierBMinutes: 25,
      kmPerMinute: 0.9,
    });
    const rankedCandidates = ranking.ranked;
    console.log('[suggest-slots][proposal_ranking]', {
      mode: PROPOSAL_CLUSTERING_FIRST ? 'clustering_first' : 'legacy',
      ...ranking.telemetry,
    });

    const suggestions = rankedCandidates.slice(0, maxSuggest).map((c) => ({
      dateStr: c.dateStr,
      dateLabel: c.dateLabel,
      block: c.block,
      blockLabel: c.blockLabel,
      timeLabel: c.timeLabel,
      existingCount: c.existingCount,
      slotsLeft: c.slotsLeft,
      score: Math.round(c.score * 10) / 10,
    }));
    perf.map_sort_slice_ms = Date.now() - tMap0;

    if (suggestTrace) {
      logAvailability('suggest_booking_flow_summary', {
        flow: 'suggest-slots',
        httpResponse: 200,
        suggestionCount: suggestions.length,
        windowAmsterdam: [startDate, endDate],
        timeZone: 'Europe/Amsterdam',
        dayDecisions: suggestTrace.days,
        finalSlotsReturnedToFrontend: suggestions.map((s) => ({
          dateStr: s.dateStr,
          block: s.block,
          slotsLeft: s.slotsLeft,
          timeLabel: s.timeLabel,
        })),
        suggestionEngine: 'block-capacity-offers',
      });
    }
    console.log(
      '[suggest-slots] final_proposals_2',
      suggestions.map((s) => ({
        dateStr: s.dateStr,
        block: s.block,
        timeLabel: s.timeLabel,
      }))
    );

    return res.status(200).json({
      success: true,
      contactId: resolvedContactId,
      contactName,
      contactPhone,
      address,
      suggestions,
      meta: {
        source: 'block-capacity-offers',
        startDate,
        endDate,
        windowMs: { startMs: startBounds.startMs, endMs: endBounds.endMs },
        calendarId: calId,
      },
    });
  } catch (err) {
    console.error('[suggest-slots]', err?.message || err);
    perf.handler_error = String(err?.message || err).slice(0, 200);
    return res.status(500).json({
      success: false,
      error: err?.message || 'Serverfout bij tijdsloten',
    });
  } finally {
    perf.total_ms = Date.now() - reqT0;
    console.log('[timing suggest-slots]', JSON.stringify(perf));
  }
}
