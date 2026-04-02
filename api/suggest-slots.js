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
import {
  dayHasCustomerBlockingOverlap,
  HK_DEFAULT_BLOCK_SLOT_USER_ID,
} from '../lib/ghl-calendar-blocks.js';
import { fetchWithRetry } from '../lib/retry.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';

/** ~6 weken vooruit (42 dagen), conform gewenst venster. */
const FREE_SLOTS_DAYS = 42;

/** Fallbacks als env leeg (productie: zet GHL_CALENDAR_ID / GHL_LOCATION_ID). */
const SUGGEST_CALENDAR_FALLBACK = 'vdZlb1g9Ii8tIdCwwXDx';
const SUGGEST_LOCATION_FALLBACK = 'KVD6wOE9g1g2V9z7Zxj7';

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

function stripGhlEnvId(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function effectiveSuggestCalendarId() {
  return stripGhlEnvId(GHL_CALENDAR_ID) || SUGGEST_CALENDAR_FALLBACK;
}

function effectiveSuggestLocationId() {
  return stripGhlEnvId(GHL_LOCATION_ID) || SUGGEST_LOCATION_FALLBACK;
}

/** Zelfde user als confirm-booking / GHL blok-slots (personal blocks zonder event-calendar). */
function effectiveBlockSlotUserId() {
  return (
    stripGhlEnvId(process.env.GHL_BLOCK_SLOT_USER_ID) ||
    stripGhlEnvId(process.env.GHL_APPOINTMENT_ASSIGNED_USER_ID) ||
    HK_DEFAULT_BLOCK_SLOT_USER_ID
  );
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

/** GHL free-slots payload → object met datum-keys (of één array onder _all). */
function extractSlotsObject(data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.slots)) return { _all: data.slots };
  const inner =
    data.slots ?? data.data?.slots ?? data.result ?? data.freeSlots ?? data.availability ?? data.data?.result;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  return null;
}

function slotStartMs(slot) {
  if (!slot || typeof slot !== 'object') return NaN;
  const raw = slot.startTime ?? slot.start ?? slot.from ?? slot.slotTime ?? slot.dateTime;
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw < 1e12 ? Math.round(raw * 1000) : raw;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Tel vrije slots per Amsterdam-kalenderdag en ochtend / middag (split op DAYPART_SPLIT_HOUR).
 */
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
  /** Zonder locationId eerst (match met werkende curl); daarna mét locatie + alt. route. */
  const urlAttempts = [
    `${GHL_BASE}/calendars/${encCal}/free-slots?${baseQs}`,
    `${GHL_BASE}/calendars/${encCal}/free-slots?${withLoc}`,
    `${GHL_BASE}/calendars/free-slots?${baseQs}&calendarId=${encCal}`,
    `${GHL_BASE}/calendars/free-slots?${withLoc}&calendarId=${encCal}`,
  ];
  const versions = ['2021-04-15', '2021-07-28'];
  let lastErr = '';
  const seen = new Set();
  for (const url of urlAttempts) {
    if (seen.has(url)) continue;
    seen.add(url);
    for (const Version of versions) {
      const r = await fetchWithRetry(
        url,
        { headers: { Authorization: `Bearer ${apiKey}`, Version } },
        0
      );
      const txt = await r.text().catch(() => '');
      if (!r.ok) {
        lastErr = `${r.status} ${txt.slice(0, 200)}`;
        continue;
      }
      let data;
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        lastErr = 'JSON parse';
        continue;
      }
      const slotsObj = extractSlotsObject(data);
      if (slotsObj) return { ok: true, data, slotsObj };
      lastErr = 'Geen slots-object in response';
    }
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

    if (!contactId && !addressParam && !nameParam && !phoneParam) {
      return res.status(400).json({ error: 'contactId, address, name of phone vereist' });
    }

    if (!GHL_API_KEY) {
      return res.status(500).json({ success: false, error: 'GHL API key ontbreekt' });
    }

    const locId = effectiveSuggestLocationId();
    const calId = effectiveSuggestCalendarId();

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

    const byDay = aggregateFreeSlotsByAmsterdamDay(free.slotsObj);

    const candidates = [];

    let cursor = startDate;
    for (let i = 0; i < FREE_SLOTS_DAYS; i++) {
      if (!cursor) break;
      const dow = amsterdamWeekdaySun0(cursor);
      if (dow !== 0 && dow !== 6) {
        if (
          await dayHasCustomerBlockingOverlap(
            GHL_BASE,
            {
              locationId: locId,
              calendarId: calId,
              apiKey: GHL_API_KEY,
              assignedUserId: effectiveBlockSlotUserId(),
            },
            cursor
          )
        ) {
          cursor = addAmsterdamCalendarDays(cursor, 1);
          continue;
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

        for (const block of ['morning', 'afternoon']) {
          const freeCount = block === 'morning' ? counts.morning : counts.afternoon;
          if (freeCount < 1) continue;
          if (!blockAllowsNewCustomerBooking(block, [], workType)) continue;

          const maxB = customerMaxForBlock(block);
          const slotsLeft = Math.min(freeCount, maxB);
          const existingCount = maxB - slotsLeft;

          let score = i * 10 + (block === 'morning' ? 0 : 1);
          if (newCoord) {
            let events = [];
            try {
              const b = amsterdamCalendarDayBoundsMs(cursor);
              if (b) {
                const er = await fetch(
                  `${GHL_BASE}/calendars/events?locationId=${encodeURIComponent(locId)}&calendarId=${encodeURIComponent(calId)}&startTime=${b.startMs}&endTime=${b.endMs}`,
                  { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' } }
                );
                if (er.ok) {
                  const ed = await er.json();
                  events = [...(ed?.events || [])].filter((e) => e.contactId || e.contact_id);
                }
              }
            } catch {}
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
