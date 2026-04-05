// api/send-booking-invite.js
// Berekent tot 2 klantopties (datum + dagdeel) via lib/block-capacity-offers.js — zelfde engine als suggest-slots.
// Zet custom fields (+ optioneel tag) zodat een GHL-workflow het WhatsApp-template verstuurt.

import {
  addAmsterdamCalendarDays,
  amsterdamCalendarDayBoundsMs,
  amsterdamWeekdaySun0,
  formatYyyyMmDdInAmsterdam,
} from '../lib/amsterdam-calendar-day.js';
import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { normalizeWorkType, plannedMinutesForType } from '../lib/booking-blocks.js';
import {
  blockDisplayLabels,
  blockOfferKey,
  evaluateBlockOffer,
} from '../lib/block-capacity-offers.js';
import { fetchWithRetry } from '../lib/retry.js';
import { normalizeNlPhone } from '../lib/ghl-phone.js';
import { signBookingToken } from '../lib/session.js';
import { availabilityDebugEnabled, logAvailability } from '../lib/availability-debug.js';
import {
  isCustomerBookingBlockedOnAmsterdamDate,
  markBlockLikeOnCalendarEvents,
  resolveAssignedUserIdForBlockedSlotQueries,
} from '../lib/ghl-calendar-blocks.js';
import {
  cachedFetchBlockedSlotsAsEvents,
  cachedFetchCalendarEventsForDay,
  cachedListConfirmedSyntheticEventsForDate,
} from '../lib/amsterdam-day-read-cache.js';
import { ghlCalendarIdFromEnv, ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import {
  buildProposalScanSchedule,
  effectiveMaxOptions,
  parseProposalConstraints,
  proposalBlocksToEvaluate,
  proposalConstraintsPassCandidate,
} from '../lib/proposal-constraints.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

/** Zelfde availability-context als confirm-booking / suggest-slots (Europe/Amsterdam-dag via GHL). */
function customerAvailabilityCtx() {
  return {
    locationId: GHL_LOCATION_ID,
    calendarId: ghlCalendarIdFromEnv(),
    apiKey: GHL_API_KEY,
    assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
  };
}

/** Publieke basis-URL voor boekingslinks */
function publicBaseUrl() {
  const fromEnv = process.env.BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return 'https://planning.hetekraan.nl';
}
const DAYS_AHEAD      = 7;

const FIELD_IDS = {
  straatnaam:     'ZwIMY4VPelG5rKROb5NR',
  huisnummer:     'co5Mr16rF6S6ay5hJOSJ',
  postcode:       '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:     'mFRQjlUppycMfyjENKF9',
  type_onderhoud: 'EXSQmlt7BqkXJMs8F3Qk',
};

function getField(contact, fieldId) {
  const f = contact?.customFields?.find(f => f.id === fieldId);
  return f?.value || '';
}

/** Synthetische klant-afspraak voor capaciteit na eerste invite-keuze (zelfde dagdeel + duur als workType). */
function syntheticCustomerBookingForBlock(dateStr, block, workType) {
  const w = normalizeWorkType(workType);
  const durMin = plannedMinutesForType(w);
  const hour = block === 'morning' ? 10 : 14;
  const start = amsterdamWallTimeToDate(dateStr, hour, 0);
  const startMs = start ? start.getTime() : Date.now();
  return {
    startTime: startMs,
    endTime: startMs + durMin * 60 * 1000,
    title: `__invite__ ${w}`,
    contactId: 'synthetic-invite-pick',
  };
}

function augmentMergedForPicks(baseMerged, dateStr, picks, workType) {
  const arr = Array.isArray(baseMerged) ? [...baseMerged] : [];
  for (const p of picks) {
    if (p.dateStr !== dateStr) continue;
    arr.push(syntheticCustomerBookingForBlock(p.dateStr, p.block, workType));
  }
  return arr;
}

function dutchDateLabel(dateStr) {
  const dayBounds = amsterdamCalendarDayBoundsMs(dateStr);
  if (!dayBounds) return dateStr;
  return new Date(dayBounds.startMs + 12 * 3600000).toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Amsterdam',
  });
}

/**
 * Tot 2 opties `dateStr` + `block`, zelfde regels als api/suggest-slots (block-capacity-offers + merged kalender).
 * @param {Record<string, unknown> | null | undefined} proposalConstraints — geparsed; null = geen filter
 */
async function pickBlockInviteOffers(workType, timings, proposalConstraints = null) {
  const perf = timings || null;
  if (!GHL_API_KEY) return [];
  const calId = ghlCalendarIdFromEnv();
  const locId = ghlLocationIdFromEnv();
  if (!calId || !locId) return [];

  const todayAmsterdam = formatYyyyMmDdInAmsterdam(new Date());
  if (!todayAmsterdam) return [];
  const startDate = addAmsterdamCalendarDays(todayAmsterdam, 1);
  if (!startDate) return [];

  const dbg = availabilityDebugEnabled();
  const trace = dbg ? { flow: 'send-booking-invite', timeZone: 'Europe/Amsterdam', dayDecisions: [] } : null;

  const eventCache = new Map();

  async function loadMergedCalendarDayEvents(dateStr) {
    if (eventCache.has(dateStr)) return eventCache.get(dateStr);
    const dayBounds = amsterdamCalendarDayBoundsMs(dateStr);
    if (!dayBounds) {
      eventCache.set(dateStr, []);
      return [];
    }
    const tCal = Date.now();
    const raw = await cachedFetchCalendarEventsForDay(dateStr, {
      base: GHL_BASE,
      locationId: GHL_LOCATION_ID,
      calendarId: calId,
      apiKey: GHL_API_KEY,
    });
    if (perf) perf.ghl_calendar_fetch_sum_ms += Date.now() - tCal;
    if (raw === null) {
      eventCache.set(dateStr, null);
      return null;
    }
    const calEv = Array.isArray(raw) ? raw : [];
    const tBlk = Date.now();
    const blockedMerged = await cachedFetchBlockedSlotsAsEvents(
      GHL_BASE,
      {
        locationId: GHL_LOCATION_ID,
        calendarId: calId,
        apiKey: GHL_API_KEY,
        assignedUserId: resolveAssignedUserIdForBlockedSlotQueries(),
      },
      dayBounds
    );
    if (perf) perf.blocked_slots_fetch_sum_ms += Date.now() - tBlk;
    const merged = calEv.concat(Array.isArray(blockedMerged) ? blockedMerged : []);
    markBlockLikeOnCalendarEvents(merged);
    eventCache.set(dateStr, merged);
    return merged;
  }

  /** Zelfde als suggest-slots: merged GHL + bevestigde Redis-reserveringen als synthetische events. */
  async function eventsForCapacityForDate(dateStr) {
    const merged = await loadMergedCalendarDayEvents(dateStr);
    if (merged === null) return null;
    let resvSynthetic = [];
    try {
      const tR = Date.now();
      resvSynthetic = await cachedListConfirmedSyntheticEventsForDate(dateStr);
      if (perf) perf.redis_synthetic_sum_ms += Date.now() - tR;
    } catch (e) {
      console.warn('[send-booking-invite] block reservations:', e?.message || e);
    }
    return resvSynthetic.length > 0 ? [...merged, ...resvSynthetic] : merged;
  }

  /** @type {{ dateStr: string, block: 'morning'|'afternoon', score: number, dateLabel: string, blockLabel: string, timeLabel: string }[]} */
  const candidates = [];

  const schedule = buildProposalScanSchedule({
    startDate,
    defaultHorizonDays: DAYS_AHEAD,
    proposalConstraints,
  });
  const blocksToTry = proposalBlocksToEvaluate(proposalConstraints);

  const processOneDay = async (cursor, i) => {
    try {
      const tDb = Date.now();
      const db = await isCustomerBookingBlockedOnAmsterdamDate(GHL_BASE, customerAvailabilityCtx(), cursor);
      if (perf) perf.day_blocked_check_sum_ms += Date.now() - tDb;
      if (db) {
        if (trace) trace.dayDecisions.push({ dateStr: cursor, outcome: 'excluded', why: 'day_blocked' });
        return;
      }
    } catch (e) {
      console.error('[send-booking-invite] availability check:', e?.message || e);
      throw e;
    }

    const eventsForCapacity = await eventsForCapacityForDate(cursor);
    if (eventsForCapacity === null) return null;

    const dateLabel = dutchDateLabel(cursor);

    for (const block of blocksToTry) {
      if (!proposalConstraintsPassCandidate(cursor, block, proposalConstraints)) continue;
      const tEv = Date.now();
      const evaluation = evaluateBlockOffer({
        dateStr: cursor,
        block,
        workType,
        events: eventsForCapacity,
        dayBlocked: false,
      });
      if (perf) perf.evaluate_block_offer_sum_ms += Date.now() - tEv;
      if (!evaluation.eligible) {
        if (trace) {
          trace.dayDecisions.push({
            dateStr: cursor,
            outcome: 'excluded',
            why: evaluation.reason || 'not_eligible',
            part: block,
          });
        }
        continue;
      }
      const labels = blockDisplayLabels(block);
      candidates.push({
        dateStr: cursor,
        block,
        score: (evaluation.score ?? 0) + i * 0.02,
        dateLabel,
        blockLabel: labels.blockLabelNl,
        timeLabel: labels.slotLabelSpace,
      });
    }
    return undefined;
  };

  try {
    if (schedule.kind === 'list') {
      for (let j = 0; j < schedule.dates.length; j++) {
        const cursor = schedule.dates[j];
        const r = await processOneDay(cursor, j);
        if (r === null) return [];
      }
    } else {
      let cursor = schedule.start;
      for (let i = 0; i < schedule.horizon; i++) {
        if (!cursor) break;
        const dow = amsterdamWeekdaySun0(cursor);
        if (dow === 0 || dow === 6) {
          if (trace) trace.dayDecisions.push({ dateStr: cursor, outcome: 'excluded', why: 'weekend' });
          cursor = addAmsterdamCalendarDays(cursor, 1);
          continue;
        }
        const r = await processOneDay(cursor, i);
        if (r === null) return [];
        cursor = addAmsterdamCalendarDays(cursor, 1);
      }
    }
  } catch {
    return [];
  }

  candidates.sort((a, b) => a.score - b.score);
  if (candidates.length === 0) {
    if (trace) {
      logAvailability('invite_booking_flow_summary', {
        ...trace,
        offeredToClient: [],
        source: 'block-capacity-offers',
      });
    }
    return [];
  }

  const maxPick = effectiveMaxOptions(proposalConstraints, 2, 3);
  const picked = [];
  const tryPickMore = async () => {
    for (const c of candidates) {
      if (picked.length >= maxPick) break;
      if (picked.some((p) => p.dateStr === c.dateStr && p.block === c.block)) continue;

      const baseWithResv = await eventsForCapacityForDate(c.dateStr);
      if (baseWithResv === null) continue;
      const events = augmentMergedForPicks(baseWithResv, c.dateStr, picked, workType);
      const tEv2 = Date.now();
      const evaluation = evaluateBlockOffer({
        dateStr: c.dateStr,
        block: c.block,
        workType,
        events,
        dayBlocked: false,
      });
      if (perf) perf.evaluate_block_offer_sum_ms += Date.now() - tEv2;
      if (evaluation.eligible) picked.push(c);
    }
  };

  picked.push(candidates[0]);
  await tryPickMore();

  if (trace) {
    logAvailability('invite_booking_flow_summary', {
      ...trace,
      offeredToClient: picked.map((c) => ({
        dateStr: c.dateStr,
        block: c.block,
        offerKey: blockOfferKey(c.dateStr, c.block),
      })),
      source: 'block-capacity-offers',
    });
  }

  return picked;
}

function parseRequestBody(req) {
  if (req.method !== 'POST') return req.query || {};
  let b = req.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return {};
    }
  }
  return b && typeof b === 'object' ? b : {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const reqT0 = Date.now();
  const perf = {
    route: 'send-booking-invite',
    ghl_calendar_fetch_sum_ms: 0,
    blocked_slots_fetch_sum_ms: 0,
    redis_synthetic_sum_ms: 0,
    day_blocked_check_sum_ms: 0,
    evaluate_block_offer_sum_ms: 0,
    contact_resolve_ms: 0,
    ghl_contact_get_ms: 0,
    ghl_contact_put_phone_ms: 0,
    ghl_invite_puts_ms: 0,
    ghl_tag_ops_ms: 0,
    pick_block_wall_ms: 0,
    map_token_response_ms: 0,
  };

  try {
  const body = parseRequestBody(req);
  const tResolve0 = Date.now();
  let { contactId, name: nameParam, phone: phoneParam, address: addressParam, type: typeParam, workType: workTypeParam } = body;

  // Zoek contact op naam of telefoon als er geen contactId is
  if (!contactId) {
    const searchPhone = (phoneParam || '').replace(/\s/g, '');
    if (searchPhone) {
      const sr = await fetch(
        `${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(searchPhone)}`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
      );
      if (sr.ok) contactId = (await sr.json())?.contact?.id || null;
    }
    if (!contactId && nameParam) {
      const nr = await fetch(
        `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(nameParam)}&limit=1`,
        { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
      );
      if (nr.ok) contactId = (await nr.json())?.contacts?.[0]?.id || null;
    }
    // Maak nieuw contact aan als niet gevonden
    if (!contactId && (nameParam || phoneParam)) {
      const parts = (nameParam || '').trim().split(' ');
      const cc = await fetch(`${GHL_BASE}/contacts/`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
        body: JSON.stringify({
          locationId: GHL_LOCATION_ID,
          firstName: parts[0] || nameParam,
          lastName: parts.slice(1).join(' ') || '',
          phone: normalizeNlPhone((phoneParam || '').replace(/\s/g, '')) || (phoneParam || '').replace(/\s/g, '') || '',
          address1: addressParam || '',
        })
      });
      if (cc.ok) contactId = (await cc.json())?.contact?.id || null;
    }
  }

  perf.contact_resolve_ms = Date.now() - tResolve0;

  if (!contactId) return res.status(400).json({ error: 'Kon geen contact vinden of aanmaken' });

  // Haal contactgegevens op
  const tGet0 = Date.now();
  const cr = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  if (!cr.ok) {
    perf.ghl_contact_get_ms = Date.now() - tGet0;
    return res.status(404).json({ error: 'Contact niet gevonden' });
  }

  const cd      = await cr.json();
  perf.ghl_contact_get_ms = Date.now() - tGet0;
  const contact = cd?.contact || cd;
  const name    = contact.firstName
    ? `${contact.firstName} ${contact.lastName || ''}`.trim()
    : (contact.name || nameParam || 'Klant');
  const firstName = contact.firstName || name.split(' ')[0];

  const straat     = getField(contact, FIELD_IDS.straatnaam);
  const huisnr     = getField(contact, FIELD_IDS.huisnummer);
  const postcode   = getField(contact, FIELD_IDS.postcode);
  const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
  const address    = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ')
    || contact.address1 || addressParam || '';

  /** E164-mobiel: formulier wint (suggest vult 06… in terwijl GHL-contact soms leeg/fout is). */
  const phoneFromRequest = normalizeNlPhone(String(phoneParam || '').replace(/\s/g, ''));
  let effectivePhone = normalizeNlPhone(String(contact.phone || '').replace(/\s/g, ''));
  if (phoneFromRequest && /^\+31[1-9]\d{8}$/.test(phoneFromRequest)) {
    effectivePhone = phoneFromRequest;
  }

  let phoneSyncedToE164 = false;
  const tPhonePut0 = Date.now();
  if (effectivePhone && /^\+31[1-9]\d{8}$/.test(effectivePhone)) {
    const raw = String(contact.phone || '').trim();
    const needsSync = !raw || !raw.startsWith('+') || normalizeNlPhone(raw) !== effectivePhone;
    if (needsSync) {
      const sync = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({ phone: effectivePhone }),
      });
      phoneSyncedToE164 = sync.ok;
      if (sync.ok) contact.phone = effectivePhone;
    }
  }
  perf.ghl_contact_put_phone_ms = Date.now() - tPhonePut0;

  const workType = normalizeWorkType(workTypeParam || typeParam || getField(contact, FIELD_IDS.type_onderhoud));
  const proposalConstraints = parseProposalConstraints(body.proposalConstraints);

  const tPick0 = Date.now();
  const slots = await pickBlockInviteOffers(workType, perf, proposalConstraints);
  perf.pick_block_wall_ms = Date.now() - tPick0;
  if (slots.length === 0) {
    return res.status(200).json({ success: false, message: 'Geen beschikbare slots in de komende 7 werkdagen.' });
  }

  const phoneInToken = (effectivePhone && /^\+31[1-9]\d{8}$/.test(effectivePhone))
    ? effectivePhone
    : (contact.phone || '');

  // Boekingstoken — Model B / tokenSchemaVersion 2: slots = dateStr + block (+ labels), geen GHL free-slot instants.
  // inviteIssuedAt: unieke waarde zodat de base64-string áltijd wijzigt → GHL "custom field updated" triggert
  // opnieuw (zelfde opties zonder dit gaven soms een identieke token = geen workflow).
  const bookingData = {
    contactId,
    name,
    phone: phoneInToken,
    email: String(contact.email || '').trim(),
    address,
    type: workType,
    inviteIssuedAt: Date.now(),
    tokenSchemaVersion: 2,
    slots: slots.map((s) => ({
      id: blockOfferKey(s.dateStr, s.block),
      dateStr: s.dateStr,
      block: s.block,
      label: `${capitalize(s.dateLabel)} ${s.blockLabel}`,
      time: s.timeLabel,
    })),
  };
  const token = signBookingToken(bookingData);
  // Query-URL: /book/<token> geeft met cleanUrls 404 op Vercel; /book?token= laadt book.html wel.
  const bookingUrl = `${publicBaseUrl()}/book?token=${encodeURIComponent(token)}`;

  // Custom field IDs voor GHL workflow
  const FIELD_SLOT1  = 'EiSw9gZQSG4kyhPn1rtF'; // Tijdslot optie 1
  const FIELD_SLOT2  = '7Fi0c2XTjEiZve3ORFjM'; // Tijdslot optie 2
  const FIELD_TOKEN  = 'whvgJ2ILKYukDlVj81rp'; // Boekings token

  const slot1 = slots[0];
  const slot2 = slots[1];
  // Voorbeeldtekst (zelfde inhoud als template); wordt niet meer via API verstuurd.
  let message = `We hebben nog een gaatje op een van de volgende twee tijdslots:\n\n`;
  message += `*Optie 1:* ${capitalize(slot1.dateLabel)} tussen ${slot1.timeLabel}\n`;
  if (slot2) message += `*Optie 2:* ${capitalize(slot2.dateLabel)} tussen ${slot2.timeLabel}\n`;
  message += `\nKlik op de link om jouw voorkeur door te geven, dan plannen we het gelijk in:\n${bookingUrl}`;

  // Sla tijdsloten + token op — GHL-workflow stuurt het goedgekeurde WhatsApp-template
  const customFields = [
    { id: FIELD_SLOT1, field_value: `${capitalize(slot1.dateLabel)} tussen ${slot1.timeLabel}` },
    { id: FIELD_TOKEN, field_value: token },
  ];
  if (slot2) {
    customFields.push({ id: FIELD_SLOT2, field_value: `${capitalize(slot2.dateLabel)} tussen ${slot2.timeLabel}` });
  }

  const diag = {
    fieldsPut: false,
    tagRemove: false,
    tagAdd: false,
    phoneSyncedToE164,
    tokenClearPutOk: null,
  };

  // Workflow op custom field "Boekings token" (aanbevolen). Tag alleen als je workflow op tag gebruikt.
  const addBookingTag = process.env.BOOKING_ADD_TAG === 'true';

  // Altijd geldig mobiel meesturen als we het hebben (PUT zonder phone laat soms 06… staan → geen WhatsApp).
  const phoneForPut =
    effectivePhone && /^\+31[1-9]\d{8}$/.test(effectivePhone) ? effectivePhone : (contact.phone || '');

  /**
   * GHL triggert "custom field updated" vaak niet als de waarde gelijk blijft aan wat al in het veld staat.
   * Eerst token leegzetten (zoals handmatig wissen) + korte pauze, daarna volledige PUT — dan triggert de workflow weer.
   * Uitzetten: BOOKING_TOKEN_CLEAR_BEFORE_SET=false (bijv. dubbele workflow na leeg-puls).
   */
  const tInvitePuts0 = Date.now();
  const clearTokenFirst = process.env.BOOKING_TOKEN_CLEAR_BEFORE_SET !== 'false';
  if (clearTokenFirst) {
    const clearRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
      body: JSON.stringify({
        customFields: [{ id: FIELD_TOKEN, field_value: '' }],
        ...(phoneForPut ? { phone: phoneForPut } : {}),
      }),
    });
    diag.tokenClearPutOk = clearRes.ok;
    if (!clearRes.ok) {
      const t = await clearRes.text().catch(() => '');
      console.warn('[send-booking-invite] token clear PUT:', clearRes.status, t.slice(0, 300));
    }
    const resetMs = Math.min(Math.max(parseInt(process.env.BOOKING_TOKEN_RESET_MS || '450', 10) || 450, 0), 5000);
    if (resetMs > 0) await new Promise((r) => setTimeout(r, resetMs));
  }

  const fieldsRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({
      customFields,
      ...(phoneForPut ? { phone: phoneForPut } : {}),
    })
  });
  diag.fieldsPut = fieldsRes.ok;
  if (!fieldsRes.ok) {
    const t = await fieldsRes.text();
    console.error('[send-booking-invite] customFields PUT:', t);
  }
  perf.ghl_invite_puts_ms = Date.now() - tInvitePuts0;

  const tTag0 = Date.now();
  if (addBookingTag) {
    const delRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({ tags: ['stuur-tijdsloten'] })
    });
    diag.tagRemove = delRes.ok;
    if (!delRes.ok) {
      const t = await delRes.text();
      console.warn('[send-booking-invite] tag DELETE:', t);
    }

    await new Promise(r => setTimeout(r, 2000));

    const addRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
      body: JSON.stringify({ tags: ['stuur-tijdsloten'] })
    });
    diag.tagAdd = addRes.ok;
    if (!addRes.ok) {
      const t = await addRes.text();
      console.error('[send-booking-invite] tag POST:', t);
    }
  } else {
    diag.tagRemove = true;
    diag.tagAdd = true;
    console.log('[send-booking-invite] BOOKING_ADD_TAG=false — alleen custom fields (workflow op Boekings token)');
  }
  perf.ghl_tag_ops_ms = Date.now() - tTag0;

  const phoneOk = /^\+31[1-9]\d{8}$/.test(effectivePhone || '');
  const workflowReady = diag.fieldsPut && (addBookingTag ? diag.tagAdd : true);

  const tMap0 = Date.now();
  const outJson = {
    success: true,
    messageSent: false,
    whatsappViaApi: false,
    workflowReady,
    contactName: name,
    contactPhonePresent: phoneOk,
    slots: slots.map(s => ({ dateLabel: s.dateLabel, timeLabel: s.timeLabel, block: s.block })),
    bookingUrl,
    message,
    diag,
    workflowTip:
      'WhatsApp alleen via GHL-workflow (template). Standaard wist de API het Boekings token eerst en schrijft opnieuw. Uitzetten: BOOKING_TOKEN_CLEAR_BEFORE_SET=false. Pauze: BOOKING_TOKEN_RESET_MS. ' +
      'Trigger: veld Boekings token (whvgJ2ILKYukDlVj81rp) of BOOKING_ADD_TAG=true + tag stuur-tijdsloten. Contact +31-mobiel.',
  };
  perf.map_token_response_ms = Date.now() - tMap0;
  return res.status(200).json(outJson);
  } catch (err) {
    perf.handler_error = String(err?.message || err).slice(0, 200);
    console.error('[send-booking-invite]', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Serverfout' });
  } finally {
    perf.total_ms = Date.now() - reqT0;
    console.log('[timing send-booking-invite]', JSON.stringify(perf));
  }
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
