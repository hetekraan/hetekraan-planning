// api/ghl.js — met custom field IDs
import {
  amsterdamCalendarDayBoundsMs,
  formatYyyyMmDdInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import { ghlDurationMinutesForType, normalizeWorkType } from '../lib/booking-blocks.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { fetchWithRetry } from '../lib/retry.js';
import { sendErrorNotification } from '../lib/notify.js';
import { pulseContactTag } from '../lib/ghl-tag.js';
import { signSessionToken, parseUsers, verifySessionToken } from '../lib/session.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

/** YYYY-M-DD → YYYY-MM-DD (match met formatYyyyMmDdInAmsterdam) */
function normalizeYyyyMmDdInput(str) {
  if (!str || typeof str !== 'string') return null;
  const p = str.trim().split('-').map((x) => parseInt(x, 10));
  if (p.length !== 3 || p.some((n) => Number.isNaN(n))) return null;
  const [y, mo, d] = p;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Zelfde id kan als number of string binnenkomen — dedupe faalde dan op duplicaten. */
function canonicalGhlEventId(e) {
  const raw =
    e?.id ??
    e?.eventId ??
    e?.appointmentId ??
    e?.appointment?.id ??
    e?.calendarEvent?.id;
  if (raw == null || raw === '') return '';
  return String(raw);
}

/** Starttijd in ms (alle gangbare GHL-velden), voor filter + contact-slot-dedupe. */
function eventStartMsGhl(e) {
  const candidates = [
    e?.startTime,
    e?.start_time,
    e?.start,
    e?.appointmentStartTime,
    e?.appointment?.startTime,
    e?.calendarEvent?.startTime,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'number') {
      const ms = c < 1e12 ? Math.round(c * 1000) : c;
      if (!Number.isNaN(ms)) return ms;
    }
    if (typeof c === 'string') {
      const t = Date.parse(c);
      if (!Number.isNaN(t)) return t;
    }
  }
  return NaN;
}

/** GHL kalender-event → YYYY-MM-DD startdag in Europe/Amsterdam (of null). */
function getEventStartDayAmsterdam(e) {
  const ms = eventStartMsGhl(e);
  if (Number.isNaN(ms)) return null;
  return formatYyyyMmDdInAmsterdam(new Date(ms));
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
function dedupeGhlEventsForDashboard(list) {
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

  // Sorteer op starttijd zodat we altijd de vroegste variant houden.
  pass1.sort((a, b) => (eventStartMsGhl(a) || 0) - (eventStartMsGhl(b) || 0));

  const firstSeenMs = new Map(); // contactId → earliest startMs
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
        // Zelfde contact, start binnen 60 min na eerste event → retry-duplicaat, overslaan.
        continue;
      } else {
        // Meer dan 60 min later → legitieme tweede afspraak (bijv. ochtend + middag).
        firstSeenMs.set(cid, ms);
      }
    }
    out.push(e);
  }
  return out;
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
  const field = contact.customFields.find(f => f.id === fieldId);
  return field?.value || '';
}

/**
 * GHL: start/einde van een kalender-item zetten.
 * Sommige omgevingen gebruiken PUT …/appointments/:id, andere …/events/:id — we proberen beide + API-versies.
 */
async function putCalendarStartEnd(eventId, startIso, endIso) {
  if (!eventId) return { ok: false, err: 'Geen kalender-id' };

  const body = JSON.stringify({
    calendarId: GHL_CALENDAR_ID,
    locationId: GHL_LOCATION_ID,
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

  try {
    switch (action) {

      case 'getAppointments': {
        const dateRaw = req.query.date;
        const date = normalizeYyyyMmDdInput(
          Array.isArray(dateRaw) ? String(dateRaw[0]) : String(dateRaw || '')
        );
        if (!date) return res.status(400).json({ error: 'Ongeldige datum' });
        const bounds = amsterdamCalendarDayBoundsMs(date);
        if (!bounds) return res.status(400).json({ error: 'Ongeldige datum' });
        const { startMs, endMs } = bounds;
        const url = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`;
        const response = await fetchWithRetry(url, {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
        });
        const data = await response.json();
        const events = data?.events || [];

        // Unieke contactIds ophalen (dedupliceren: dezelfde klant kan meerdere events hebben)
        const uniqueCids = [...new Set(
          events.map(e => e.contactId || e.contact_id).filter(Boolean)
        )];

        // Alle contacten parallel ophalen — één fetch per uniek contact
        const contactMap = {};
        await Promise.all(uniqueCids.map(async (cid) => {
          try {
            const cr = await fetchWithRetry(`${GHL_BASE}/contacts/${cid}`, {
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
            });
            if (!cr.ok) return;
            const cd = await cr.json();
            contactMap[cid] = cd?.contact || cd;
          } catch (_) {}
        }));

        function enrichEvent(e, contact) {
          e.contact = contact;
          if (contact?.id) e.contactId = contact.id;
          const straat     = getField(contact, FIELD_IDS.straatnaam);
          const huisnr     = getField(contact, FIELD_IDS.huisnummer);
          const postcode   = getField(contact, FIELD_IDS.postcode);
          const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
          e.parsedAddress    = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ');
          e.parsedStraatnaam = straat;
          e.parsedHuisnummer = huisnr;
          e.parsedPostcode   = postcode;
          e.parsedWoonplaats = woonplaats;
          const werkzaamheden = getField(contact, FIELD_IDS.probleemomschrijving);
          e.parsedWork       = werkzaamheden || e.title;
          e.parsedPrice      = getField(contact, FIELD_IDS.prijs);
          e.parsedNotes      = getField(contact, FIELD_IDS.opmerkingen);
          e.parsedTimeWindow = getField(contact, FIELD_IDS.tijdafspraak) || null;
          const prijsRegelsRaw = getField(contact, FIELD_IDS.prijs_regels);
          if (prijsRegelsRaw) {
            try { e.parsedExtras = JSON.parse(prijsRegelsRaw); } catch (_) {}
          }
        }

        const enriched = events.map((e) => {
          const rawCid = e.contactId || e.contact_id;
          if (!rawCid) return e;
          e.contactId = rawCid;
          const contact = contactMap[rawCid];
          if (contact) enrichEvent(e, contact);
          return e;
        });

        /** Alleen events waarvan start op de gevraagde kalenderdag valt (Europe/Amsterdam). */
        const filtered = enriched.filter((e) => getEventStartDayAmsterdam(e) === date);
        const unique = dedupeGhlEventsForDashboard(filtered);

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-HK-GetAppointments-Filter', 'v4-amsterdam-day+id+contact-slot');
        return res.status(200).json({ events: unique });
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

        const payload = {};
        if (firstName !== undefined) payload.firstName = String(firstName).trim();
        if (lastName !== undefined) payload.lastName = String(lastName).trim();
        if (phone !== undefined) payload.phone = String(phone).replace(/\s/g, '');
        if (customFields.length) payload.customFields = customFields;

        if (Object.keys(payload).length === 0) {
          return res.status(400).json({ error: 'Geen velden om bij te werken' });
        }

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
        const { contactId, appointmentId, type, sendReview, lastService, totalPrice, extras } = req.body;
        if (!contactId) return res.status(400).json({ error: 'contactId vereist' });

        const today = formatYyyyMmDdInAmsterdam(new Date()) || new Date().toISOString().split('T')[0];
        const customFields = [
          { id: 'hiTe3Yi5TlxheJq4bLzy', field_value: today }, // datum_laatste_onderhoud
        ];
        if (type === 'installatie') {
          customFields.push({ id: 'kYP2SCmhZ21Ig0aaLl5l', field_value: today }); // datum_installatie
        }
        if (totalPrice != null) {
          customFields.push({ id: FIELD_IDS.prijs, field_value: String(totalPrice) });
        }
        if (Array.isArray(extras) && extras.length > 0) {
          customFields.push({ id: FIELD_IDS.prijs_regels, field_value: JSON.stringify(extras) });
        }

        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify({ customFields }),
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

        // Stap 2: adres opslaan als custom field
        if (address) {
          const parts = address.split(' ');
          const huisnummer = parts.find(p => /^\d/.test(p)) || '';
          const straatnaam = parts.slice(0, parts.indexOf(huisnummer)).join(' ') || address;
          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              customFields: [
                { id: FIELD_IDS.straatnaam, field_value: straatnaam },
                { id: FIELD_IDS.huisnummer, field_value: huisnummer },
                { id: FIELD_IDS.type_onderhoud, field_value: apptType || 'reparatie' },
                { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
              ]
            })
          });
        }

        // Stap 3: agenda-afspraak aanmaken (met retry bij slot-conflict)
        const [hours, minutes] = (time || '09:00').split(':').map(Number);
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
              calendarId: GHL_CALENDAR_ID,
              locationId: GHL_LOCATION_ID,
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
          const planned = String(appt.timeFrom || appt.timeTo || '09:00').trim();
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
