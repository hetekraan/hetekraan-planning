// api/suggest-slots.js
// Tijdsloten via officieel GHL GET …/free-slots (blokken + afspraken + werktijden in GHL).
// Route-fit (geocode) blijft optioneel voor sortering.

import {
  blockAllowsNewCustomerBooking,
  customerMaxForBlock,
  normalizeWorkType,
} from '../lib/booking-blocks.js';
import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  amsterdamWeekdaySun0,
  formatYyyyMmDdInAmsterdam,
  hourInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import {
  DAYPART_SPLIT_HOUR,
  SLOT_LABEL_AFTERNOON_SPACE,
  SLOT_LABEL_MORNING_SPACE,
} from '../lib/planning-work-hours.js';
import { availabilityDebugEnabled, logAvailability } from '../lib/availability-debug.js';
import {
  isCustomerBookingBlockedOnAmsterdamDate,
  resolveAssignedUserIdForBlockedSlotQueries,
} from '../lib/ghl-calendar-blocks.js';
import {
  GHL_CONFIG_MISSING_MSG,
  ghlCalendarIdFromEnv,
  ghlLocationIdFromEnv,
  stripGhlEnvId,
} from '../lib/ghl-env-ids.js';
const GHL_API_KEY = process.env.GHL_API_KEY;

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
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';

/** 1 week vooruit (7 dagen). */
const FREE_SLOTS_DAYS = 7;

const FIELD_IDS = {
  straatnaam: 'ZwIMY4VPelG5rKROb5NR',
  huisnummer: 'co5Mr16rF6S6ay5hJOSJ',
  postcode: '3bCi5hL0rR9XGG33x2Gv',
  woonplaats: 'mFRQjlUppycMfyjENKF9',
  type_onderhoud: 'EXSQmlt7BqkXJMs8F3Qk',
};

function getField(contact, fieldId) {
  const f = contact?.customFields?.find((f) => f.id === fieldId);
  return f?.value || '';
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

async function geocode(address) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${MAPS_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'OK' && d.results[0]) {
      const loc = d.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch {}
  return null;
}

function routeFitScore(newCoord, existingCoords) {
  if (existingCoords.length === 0) return 0;
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

  try {
    const q = req.method === 'POST' ? req.body : req.query;
    const {
      contactId,
      address: addressParam,
      name: nameParam,
      phone: phoneParam,
      type: typeQ,
      workType: workTypeQ,
    } = q;

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

    if (resolvedContactId) {
      try {
        const cr = await fetch(`${GHL_BASE}/contacts/${resolvedContactId}`, {
          headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
        });
        if (cr.ok) {
          const cd = await fetch(`${GHL_BASE}/contacts/${resolvedContactId}`, {
            headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
          }).then((r) => r.json());
          const contact = cd?.contact || cd;
          contactName = contact.firstName
            ? `${contact.firstName} ${contact.lastName || ''}`.trim()
            : contact.name || contactName;
          contactPhone = contact.phone || contactPhone;
          if (!address) {
            const straat = getField(contact, FIELD_IDS.straatnaam);
            const huisnr = getField(contact, FIELD_IDS.huisnummer);
            const postcode = getField(contact, FIELD_IDS.postcode);
            const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
            address =
              [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ') || contact.address1 || '';
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
              contactName = c.firstName
                ? `${c.firstName} ${c.lastName || ''}`.trim()
                : c.name || contactName;
              contactPhone = c.phone || contactPhone;
              if (!address) {
                const straat = getField(c, FIELD_IDS.straatnaam);
                const huisnr = getField(c, FIELD_IDS.huisnummer);
                const postcode = getField(c, FIELD_IDS.postcode);
                const woonplaats = getField(c, FIELD_IDS.woonplaats) || c.city || '';
                address =
                  [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ') || c.address1 || '';
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
              contactName = c.firstName
                ? `${c.firstName} ${c.lastName || ''}`.trim()
                : c.name || contactName;
              contactPhone = c.phone || contactPhone;
              if (!address) {
                const straat = getField(c, FIELD_IDS.straatnaam);
                const huisnr = getField(c, FIELD_IDS.huisnummer);
                const postcode = getField(c, FIELD_IDS.postcode);
                const woonplaats = getField(c, FIELD_IDS.woonplaats) || c.city || '';
                address =
                  [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ') || c.address1 || '';
              }
            }
          }
        } catch {}
      }
    }

    let workType = normalizeWorkType(workTypeQ || typeQ || '');
    if (!workTypeQ && !typeQ && resolvedContactId) {
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

    const newCoord = address ? await geocode(address) : null;

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
      logAvailability('suggest_slots_resolved_before_ghl', {
        resolvedContactId: resolvedContactId || null,
        workType,
        locationId: locId,
        calendarId: calId,
        windowAmsterdamYmd: [startDate, endDate],
        windowMs: { start: startBounds.startMs, end: endBounds.endMs },
        timeZone: 'Europe/Amsterdam',
        geocodeOk: !!newCoord,
      });
    }

    const free = await fetchGhlFreeSlots({
      calendarId: calId,
      locationId: locId,
      startMs: startBounds.startMs,
      endMs: endBounds.endMs,
      apiKey: GHL_API_KEY,
    });

    if (!free.ok) {
      console.error('[suggest-slots] free-slots:', free.error);
      return res.status(502).json({
        success: false,
        error: `GHL free-slots: ${free.error || 'onbekend'}`,
      });
    }

    if (availabilityDebugEnabled()) {
      const sample = pickFirstFreeSlotSample(free.slotsObj);
      if (sample) {
        const ms = slotStartMs(sample.raw);
        const ok = !Number.isNaN(ms);
        logAvailability('suggest_free_slots_slot_sample_pre_aggregate', {
          bucketDateKeyFromGhl: sample.bucketDateKey,
          slotJsType: sample.slotJsType,
          topLevelKeysOnSlotObject: sample.topLevelKeys,
          firstElementPreview:
            sample.slotJsType === 'object' && sample.raw
              ? JSON.stringify(sample.raw).slice(0, 500)
              : String(sample.raw).slice(0, 200),
          interpretedStartMs: ok ? ms : null,
          aggregationWouldCountThisSlot: ok,
          interpretationNote: ok
            ? 'slotStartMs/coercedEpochMs produced UTC ms → aggregate maps to Amsterdam calendar day + morning/afternoon'
            : 'slotStartMs returned NaN — this element is skipped in aggregateFreeSlotsByAmsterdamDay (no usable timestamp)',
        });
      }
    }

    const byDay = aggregateFreeSlotsByAmsterdamDay(free.slotsObj);

    if (availabilityDebugEnabled()) {
      logAvailability('suggest_slots_after_aggregate', {
        byDayMorningAfternoon: Object.fromEntries(
          [...byDay.entries()].map(([d, c]) => [d, { morning: c.morning, afternoon: c.afternoon }])
        ),
      });
    }

    const availabilityCtx = {
      locationId: locId,
      calendarId: calId,
      apiKey: GHL_API_KEY,
      assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
    };

    const candidates = [];
    const dbg = availabilityDebugEnabled();
    const suggestTrace = dbg
      ? { flow: 'suggest-slots', window: [startDate, endDate], timeZone: 'Europe/Amsterdam', days: [] }
      : null;

    let cursor = startDate;
    for (let i = 0; i < FREE_SLOTS_DAYS; i++) {
      if (!cursor) break;
      const dow = amsterdamWeekdaySun0(cursor);
      if (dow === 0 || dow === 6) {
        if (suggestTrace) suggestTrace.days.push({ dateStr: cursor, outcome: 'excluded', why: 'weekend' });
        cursor = addAmsterdamCalendarDays(cursor, 1);
        continue;
      }
      {
        try {
          if (await isCustomerBookingBlockedOnAmsterdamDate(GHL_BASE, availabilityCtx, cursor)) {
            cursor = addAmsterdamCalendarDays(cursor, 1);
            continue;
          }
        } catch (e) {
          console.error('[suggest-slots] availability check:', e?.message || e);
          return res.status(503).json({
            success: false,
            error: 'Agenda-blokkades tijdelijk niet beschikbaar. Probeer het later opnieuw.',
          });
        }

        const counts = byDay.get(cursor) || { morning: 0, afternoon: 0 };
        const dayBounds = amsterdamCalendarDayBoundsMs(cursor);
        const dateLabel = dayBounds
          ? new Date(dayBounds.startMs + 12 * 3600000).toLocaleDateString('nl-NL', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              timeZone: 'Europe/Amsterdam',
            })
          : cursor;

        const geocodeEvents = async (evList) => {
          const coords = [];
          for (const e of evList) {
            if (e.address) {
              const c = await geocode(e.address);
              if (c) coords.push(c);
            }
          }
          return coords;
        };

        /** Eén events-fetch per dag (was 2× bij ochtend+middag) — minder GHL 429. */
        let dayEventsForRoute = null;
        if (newCoord) {
          try {
            const b = amsterdamCalendarDayBoundsMs(cursor);
            if (b) {
              const er = await ghlFetchWith429Backoff(
                `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(locId)}&calendarId=${encodeURIComponent(calId)}&startTime=${b.startMs}&endTime=${b.endMs}`,
                { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' }
              );
              if (er.ok) {
                const ed = await er.json();
                dayEventsForRoute = [...(ed?.events || [])].filter((e) => e.contactId || e.contact_id);
              }
            }
          } catch {}
        }

        let addedForDay = 0;
        for (const block of ['morning', 'afternoon']) {
          const freeCount = block === 'morning' ? counts.morning : counts.afternoon;
          if (freeCount < 1) {
            if (suggestTrace) {
              suggestTrace.days.push({
                dateStr: cursor,
                outcome: 'excluded',
                why: 'ghl_free_slots_zero_for_part',
                part: block,
                freeSlotsByPart: { morning: counts.morning, afternoon: counts.afternoon },
              });
            }
            continue;
          }
          if (!blockAllowsNewCustomerBooking(block, [], workType)) {
            if (suggestTrace) {
              suggestTrace.days.push({
                dateStr: cursor,
                outcome: 'excluded',
                why: 'booking_rules_disallow_part',
                part: block,
                workType,
              });
            }
            continue;
          }

          const maxB = customerMaxForBlock(block);
          const slotsLeft = Math.min(freeCount, maxB);
          const existingCount = maxB - slotsLeft;

          let score = i * 10 + (block === 'morning' ? 0 : 1);
          if (newCoord) {
            const events = dayEventsForRoute ?? [];
            const blockEvents = events.filter((e) => {
              const raw = e.startTime ?? e.start;
              if (raw == null) return false;
              const ms = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
              if (Number.isNaN(ms)) return false;
              const h = hourInAmsterdam(ms);
              return block === 'morning' ? h < DAYPART_SPLIT_HOUR : h >= DAYPART_SPLIT_HOUR;
            });
            const existingCoords = await geocodeEvents(blockEvents);
            const fitScore = routeFitScore(newCoord, existingCoords);
            score = fitScore * (1 + blockEvents.length / maxB) + i * 0.01;
          }

          candidates.push({
            dateStr: cursor,
            dateLabel,
            block,
            existingCount,
            score,
            timeLabel: block === 'morning' ? SLOT_LABEL_MORNING_SPACE : SLOT_LABEL_AFTERNOON_SPACE,
            blockLabel: block === 'morning' ? 'ochtend' : 'middag',
            slotsLeft,
          });
          addedForDay++;
        }
        if (suggestTrace && addedForDay === 0 && counts.morning + counts.afternoon > 0) {
          suggestTrace.days.push({
            dateStr: cursor,
            outcome: 'excluded',
            why: 'no_part_passed_after_rules',
            freeSlotsByPart: { morning: counts.morning, afternoon: counts.afternoon },
          });
        }
      }
      cursor = addAmsterdamCalendarDays(cursor, 1);
      if (candidates.length >= 18) break;
    }

    candidates.sort((a, b) => a.score - b.score);

    const suggestions = candidates.slice(0, 3).map((c) => ({
      dateStr: c.dateStr,
      dateLabel: c.dateLabel,
      block: c.block,
      blockLabel: c.blockLabel,
      timeLabel: c.timeLabel,
      existingCount: c.existingCount,
      slotsLeft: c.slotsLeft,
      score: Math.round(c.score * 10) / 10,
    }));

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
        ghlFreeSlotsSource: 'calendars/{id}/free-slots',
      });
    }

    return res.status(200).json({
      success: true,
      contactId: resolvedContactId,
      contactName,
      contactPhone,
      address,
      suggestions,
      meta: {
        source: 'ghl-free-slots',
        startDate,
        endDate,
        freeSlotsRangeMs: { startMs: startBounds.startMs, endMs: endBounds.endMs },
        calendarId: calId,
      },
    });
  } catch (err) {
    console.error('[suggest-slots]', err?.message || err);
    return res.status(500).json({
      success: false,
      error: err?.message || 'Serverfout bij tijdsloten',
    });
  }
}
