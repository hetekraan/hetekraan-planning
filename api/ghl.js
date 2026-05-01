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
import { getOrCreateRequestId, logEvent } from '../lib/observability.js';
import { applySecurityHeaders, enforceSimpleRateLimit } from '../lib/http-security.js';
import {
  deleteGhlCalendarBlock,
  fetchBlockedSlotsAsEvents,
  HK_DEFAULT_BLOCK_SLOT_USER_ID,
  listDeletableBlockIdsForAmsterdamDay,
  listDeletableBlockIdsForMsRange,
  markBlockLikeOnCalendarEvents,
  postAmsterdamWallBlockWindow,
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
import {
  mapEnrichedGhlEventToAppointment,
  plannerServiceMarkedCompleteOnRouteDay,
  readContactCustomFieldById,
} from '../lib/planning/appointment.js';
import {
  buildCanonicalAddressWritePayload,
  logCanonicalAddressRead,
  logCanonicalAddressWrite,
  mergeGhlNativeAddressFromParts,
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
import {
  createConfirmedReservation,
  deleteConfirmedReservationForContactDate,
  listReservationsForContact,
} from '../lib/block-reservation-store.js';
import {
  getCustomerDayFullFlag,
  isCustomerDayFullStoreConfigured,
  setCustomerDayFullFlag,
} from '../lib/customer-day-full-store.js';
import {
  getRouteLock,
  isRouteLockStoreConfigured,
  setRouteLock,
} from '../lib/route-lock-store.js';
import {
  buildCompleteAppointmentPayload,
  LEGACY_COMPLETE_FIELD_IDS,
} from '../lib/usecases/complete-appointment.js';
import {
  ensureReviewMailTagOnComplete,
  REVIEW_MAIL_TAG,
} from '../lib/usecases/review-mail-tag.js';
import { resolveContactCustomFieldId } from '../lib/ghl-custom-fields.js';
import { getOrCreateMoneybirdPayTokenMapping } from '../lib/moneybird-pay-token-store.js';
import {
  appendInvoicePartyWritesToCustomFields,
  buildInvoicePartyFromContact,
  formatMoneybirdInvoiceMetadataSuffix,
  readInvoicePartyField,
  resolveInvoicePartyFieldIds,
} from '../lib/invoice-party-ghl.js';
import { syncAppointmentToSupabase } from '../lib/planner-supabase-sync.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

/** Alleen diagnostiek: laatste contactId na succesvolle updatePlannerBookingDetails PUT (voor [TRACE][mapped_address_after_edit]). */
let _traceLastEditedContactId = null;

function normalizePlannerInvoiceTypeFromBody(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'bedrijf' || t === 'zakelijk' || t === 'business') return 'bedrijf';
  return 'particulier';
}

function plannerBodyIncludesInvoiceKeys(body) {
  if (!body || typeof body !== 'object') return false;
  return [
    'factuurType',
    'factuurBedrijfsnaam',
    'factuurTav',
    'factuurEmail',
    'factuurKvk',
    'factuurBtwNummer',
    'factuurAdres',
    'factuurPostcode',
    'factuurPlaats',
    'factuurReferentie',
  ].some((k) => body[k] !== undefined);
}

/**
 * Schrijft factuur-* custom fields mee op het contact (planner modal / booking update).
 * Alleen als de client minstens één factuur-key meestuurt — zo worden oude clients niet gedwongen leeg te schrijven.
 */
async function appendPlannerInvoicePartyFieldsToCustomFields(customFields, body) {
  if (!Array.isArray(customFields) || !body || typeof body !== 'object') return;
  if (!plannerBodyIncludesInvoiceKeys(body)) return;
  const ft = normalizePlannerInvoiceTypeFromBody(body.factuurType);
  const patch = {
    factuurType: ft,
    factuurBedrijfsnaam: ft === 'bedrijf' ? String(body.factuurBedrijfsnaam ?? '').trim() : '',
    factuurTav: ft === 'bedrijf' ? String(body.factuurTav ?? '').trim() : '',
    factuurEmail: ft === 'bedrijf' ? String(body.factuurEmail ?? '').trim() : '',
    factuurKvk: ft === 'bedrijf' ? String(body.factuurKvk ?? '').trim() : '',
    factuurBtwNummer: ft === 'bedrijf' ? String(body.factuurBtwNummer ?? '').trim() : '',
    factuurAdres: ft === 'bedrijf' ? String(body.factuurAdres ?? '').trim() : '',
    factuurPostcode: ft === 'bedrijf' ? String(body.factuurPostcode ?? '').trim() : '',
    factuurPlaats: ft === 'bedrijf' ? String(body.factuurPlaats ?? '').trim() : '',
    factuurReferentie: ft === 'bedrijf' ? String(body.factuurReferentie ?? '').trim() : '',
  };
  try {
    const invoiceIds = await resolveInvoicePartyFieldIds({
      baseUrl: GHL_BASE,
      apiKey: GHL_API_KEY,
      locationId: ghlLocationIdFromEnv(),
    });
    appendInvoicePartyWritesToCustomFields(customFields, invoiceIds, patch);
  } catch (invErr) {
    console.warn('[planner_booking] invoice_party_fields_skip', invErr?.message || invErr);
  }
}

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
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  prijs:               'HGjlT6ofaBiMz3j2HsXL',
  prijs_regels:        'gPjrUG2eH81PeALh8tVS',
  tijdafspraak:        'RfKARymCOYYkufGY053T',
  /** Zelfde ID als api/cron/morning-messages.js — voor ETA/ochtend-template in workflow */
  geplande_aankomst:   'XELcOSdWq3tqRtpLE5x8',
  opmerkingen:         'LCIFALarX3WZI5jsBbDA',
  /** Niet hardcoded: runtime resolve via key `planner_notities` (optioneel env override). */
  planner_notities:    String(process.env.GHL_FIELD_ID_PLANNER_NOTITIES || '').trim(),
  /** Interne vaste aankomsttijd/pin (operationeel). */
  planner_internal_fixed_start: String(process.env.GHL_FIELD_ID_PLANNER_INTERNAL_FIXED_START || '').trim(),
};

/**
 * Leest custom field van GHL contact-response.
 * Sommige responses matchen beter op `key`/`fieldKey` dan op id (of id is number vs string).
 */
function getField(contact, fieldId, fieldKeyHint) {
  if (!contact?.customFields || !Array.isArray(contact.customFields)) return '';
  const fid = String(fieldId || '').trim();
  if (fid) {
    const field = contact.customFields.find((f) => {
      const rid = String(f?.id ?? f?.fieldId ?? f?.customFieldId ?? '').trim();
      return rid === fid;
    });
    const raw = field?.value ?? field?.field_value;
    if (raw != null && String(raw).trim() !== '') return String(raw);
  }
  const hint = String(fieldKeyHint || '').trim();
  if (hint) {
    const byKey = contact.customFields.find((f) => {
      const k = String(f?.key || f?.fieldKey || '').trim();
      return k === hint;
    });
    const raw2 = byKey?.value ?? byKey?.field_value;
    if (raw2 != null && String(raw2).trim() !== '') return String(raw2);
  }
  return '';
}

async function resolvePlannerNotitiesFieldId() {
  return resolveContactCustomFieldId({
    baseUrl: GHL_BASE,
    apiKey: GHL_API_KEY,
    locationId: ghlLocationIdFromEnv(),
    fieldKey: 'planner_notities',
    objectType: 'contact',
    envOverride: FIELD_IDS.planner_notities,
  });
}

async function resolvePlannerInternalFixedStartFieldId() {
  return resolveContactCustomFieldId({
    baseUrl: GHL_BASE,
    apiKey: GHL_API_KEY,
    locationId: ghlLocationIdFromEnv(),
    fieldKey: 'planner_internal_fixed_start',
    objectType: 'contact',
    envOverride: FIELD_IDS.planner_internal_fixed_start,
  });
}

function normalizeInternalFixedPinFromBody(raw) {
  if (raw == null || raw === '') return null;
  let type = 'exact';
  let timeRaw = '';
  if (typeof raw === 'object') {
    type = String(raw.type || '').trim().toLowerCase() || 'exact';
    timeRaw = String(raw.time || '').trim();
  } else {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s.startsWith('{')) {
      try {
        const parsed = JSON.parse(s);
        type = String(parsed?.type || '').trim().toLowerCase() || 'exact';
        timeRaw = String(parsed?.time || '').trim();
      } catch {
        type = 'exact';
        timeRaw = s;
      }
    } else {
      type = 'exact';
      timeRaw = s;
    }
  }
  if (type !== 'exact' && type !== 'after' && type !== 'before') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeRaw || '').replace(/^~/, '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return null;
  const time = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return { type, time };
}

async function resolveMoneybirdFieldIds() {
  const [invoiceIdFieldId, invoiceUrlFieldId, referenceFieldId, invoiceTokenFieldId] = await Promise.all([
    resolveContactCustomFieldId({
      baseUrl: GHL_BASE,
      apiKey: GHL_API_KEY,
      locationId: ghlLocationIdFromEnv(),
      fieldKey: 'moneybird_invoice_id',
      objectType: 'contact',
      envOverride: String(process.env.GHL_FIELD_ID_MONEYBIRD_INVOICE_ID || '').trim(),
    }),
    resolveContactCustomFieldId({
      baseUrl: GHL_BASE,
      apiKey: GHL_API_KEY,
      locationId: ghlLocationIdFromEnv(),
      fieldKey: 'moneybird_invoice_url',
      objectType: 'contact',
      envOverride: String(process.env.GHL_FIELD_ID_MONEYBIRD_INVOICE_URL || '').trim(),
    }),
    resolveContactCustomFieldId({
      baseUrl: GHL_BASE,
      apiKey: GHL_API_KEY,
      locationId: ghlLocationIdFromEnv(),
      fieldKey: 'moneybird_invoice_reference',
      objectType: 'contact',
      envOverride: String(process.env.GHL_FIELD_ID_MONEYBIRD_INVOICE_REFERENCE || '').trim(),
    }),
    resolveContactCustomFieldId({
      baseUrl: GHL_BASE,
      apiKey: GHL_API_KEY,
      locationId: ghlLocationIdFromEnv(),
      fieldKey: 'moneybird_invoice_token',
      objectType: 'contact',
      envOverride: String(process.env.GHL_FIELD_ID_MONEYBIRD_INVOICE_TOKEN || '').trim(),
    }),
  ]);
  return { invoiceIdFieldId, invoiceUrlFieldId, referenceFieldId, invoiceTokenFieldId };
}

function buildMoneybirdReference({ appointmentId, contactId, serviceDay }) {
  const appt = String(appointmentId || '').trim();
  if (appt) return `hk-appt:${appt}`;
  const cid = String(contactId || '').trim();
  const day = String(serviceDay || '').trim();
  if (cid && day) return `hk-contact:${cid}:${day}`;
  return '';
}

function parseMoneybirdInvoiceFromPlannerNotes(notes) {
  const raw = String(notes || '');
  if (!raw) return { invoiceId: '', invoiceUrl: '', reference: '' };
  const m = raw.match(/\[moneybird\]\s+invoiceId=([^\s]+)\s+reference=([^\s]+)(?:\s+url=(\S+))?/i);
  return {
    invoiceId: m?.[1] ? String(m[1]).trim() : '',
    reference: m?.[2] ? String(m[2]).trim() : '',
    invoiceUrl: m?.[3] ? String(m[3]).trim() : '',
  };
}

function appendMoneybirdPlannerNote(existing, { invoiceId, reference, invoiceUrl }) {
  const marker = `[moneybird] invoiceId=${String(invoiceId || '').trim()} reference=${String(reference || '').trim()}${invoiceUrl ? ` url=${String(invoiceUrl).trim()}` : ''}`;
  const base = String(existing || '').trim();
  if (!base) return marker;
  if (base.includes(marker)) return base;
  return `${base}\n${marker}`;
}

function mbGhlLocationIdForLog() {
  return String(ghlLocationIdFromEnv() || '').trim();
}

function mbSummarizeGhlResponseText(text, max = 400) {
  const s = String(text || '').replace(/[\u0000-\u001f]+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Logt customFields veilig: per veld id + lengte + korte preview (geen volledige URLs). */
function mbSummarizeCustomFieldsForLog(customFields) {
  if (!Array.isArray(customFields)) return [];
  return customFields.map((f) => {
    const id = f?.id != null ? String(f.id) : '';
    const raw =
      f?.field_value != null
        ? String(f.field_value)
        : f?.value != null
          ? String(f.value)
          : '';
    const preview =
      raw.length <= 96 ? raw : `${raw.slice(0, 48)}…${raw.slice(-12)}`;
    return { id, field_value_len: raw.length, field_value_preview: preview };
  });
}

/** Zelfde patroon als appendBookingCanonFields: GHL verwacht vaak zowel `value` als `field_value`. */
function mbNormalizeMoneybirdCustomFieldsForGhl(customFields) {
  if (!Array.isArray(customFields)) return [];
  return customFields
    .map((f) => {
      const id = String(f?.id ?? '').trim();
      const v =
        f?.field_value != null
          ? String(f.field_value)
          : f?.value != null
            ? String(f.value)
            : '';
      if (!id) return null;
      return { id, field_value: v, value: v };
    })
    .filter(Boolean);
}

function mbTryParseGhlJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

/** GHL gebruikt soms `succeded` (typo) i.p.v. `success` in JSON bodies. */
function mbGhlBodyIndicatesWriteOk(parsed) {
  if (!parsed || typeof parsed !== 'object') return true;
  if ('success' in parsed && parsed.success === false) return false;
  if ('succeded' in parsed && parsed.succeded === false) return false;
  if ('succeeded' in parsed && parsed.succeeded === false) return false;
  return true;
}

/**
 * GHL UI schrijft contact custom fields via dezelfde route: PUT …/contacts/:contactId
 * met body `{ "customFields": [ { "id": "<uuid>", "value": "…", "field_value": "…" } ] }`.
 * Zie ook `appendBookingCanonFields` (lib/booking-canon-fields.js) — daar zitten beide keys op elke regel.
 */
function mbGhlContactGetUrl(contactId) {
  const cid = encodeURIComponent(String(contactId || '').trim());
  const loc = mbGhlLocationIdForLog();
  if (loc) {
    return `${GHL_BASE}/contacts/${cid}?locationId=${encodeURIComponent(loc)}`;
  }
  return `${GHL_BASE}/contacts/${cid}`;
}

/** Eén GET …/contacts/:id — gedeeld door readback en token-field logging. */
async function mbGhlContactGetParsed(contactId) {
  const getRes = await fetchWithRetry(mbGhlContactGetUrl(contactId), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: '2021-04-15',
    },
    _allowPostRetry: false,
  });
  const raw = await getRes.text().catch(() => '');
  const j = mbTryParseGhlJson(raw);
  const contact = j?.contact || j || {};
  return { httpStatus: getRes.status, contact };
}

/** GET contact en lees één custom field (id + optionele key-hint). */
async function mbFetchContactAndGetField({ contactId, fieldId, fieldKeyHint }) {
  const { httpStatus, contact } = await mbGhlContactGetParsed(contactId);
  const val = String(getField(contact, fieldId, fieldKeyHint) || '').trim();
  return { httpStatus, value: val, contact };
}

async function mbReadbackMoneybirdCustomFields({ contactId, checks, phase }) {
  if (!contactId || !Array.isArray(checks) || checks.length === 0) {
    return { ok: true, missing: [], httpStatus: 0 };
  }
  try {
    const { httpStatus, contact } = await mbGhlContactGetParsed(contactId);

    const missing = [];
    for (const c of checks) {
      const fid = String(c.fieldId || '').trim();
      const exp = String(c.expectedValue ?? '').trim();
      if (!fid) continue;
      const got = String(getField(contact, fid, c.fieldKey) || '').trim();
      if (got !== exp) {
        missing.push({
          name: c.name || 'unknown',
          fieldId: fid,
          expectedLen: exp.length,
          gotLen: got.length,
        });
      }
    }
    if (missing.length === 0) {
      console.info(
        '[moneybird] ghl_contact_readback_success',
        JSON.stringify({
          contactId,
          phase,
          httpStatus,
          checked: checks.length,
        })
      );
      return { ok: true, missing: [], httpStatus };
    }
    console.warn(
      '[moneybird] ghl_contact_readback_missing_fields',
      JSON.stringify({
        contactId,
        phase,
        httpStatus,
        missing,
      })
    );
    return { ok: false, missing, httpStatus };
  } catch (e) {
    console.warn(
      '[moneybird] ghl_contact_readback_missing_fields',
      JSON.stringify({
        contactId,
        phase,
        error: e?.message || String(e),
        missing: checks.map((c) => ({ name: c.name, fieldId: c.fieldId })),
      })
    );
    return { ok: false, missing: checks.map((c) => ({ name: c.name, fieldId: c.fieldId })), httpStatus: 0 };
  }
}

/**
 * Laatste redmiddel: sequentieel payload-varianten proberen tot readback voor moneybird_invoice_token slaagt.
 */
async function mbTryMoneybirdInvoiceTokenWriteStrategies({
  contactId,
  fieldId,
  fieldKey,
  tok,
  phase,
}) {
  const id = String(fieldId || '').trim();
  const key = String(fieldKey || 'moneybird_invoice_token').trim();
  const v = String(tok || '').trim();
  if (!contactId || !id || !v) return { ok: false, strategy: null, readback: null };

  const endpoint = `${GHL_BASE}/contacts/${contactId}`;
  const versions = ['2021-07-28', '2021-04-15'];
  const strategies = [
    { name: 'id_value_field_value', fields: [{ id, value: v, field_value: v }] },
    { name: 'id_value_only', fields: [{ id, value: v }] },
    { name: 'id_field_value_only', fields: [{ id, field_value: v }] },
    { name: 'key_value_field_value', fields: [{ key, value: v, field_value: v }] },
    { name: 'fieldKey_value_field_value', fields: [{ fieldKey: key, value: v, field_value: v }] },
    { name: 'customFieldId_with_value', fields: [{ customFieldId: id, value: v, field_value: v }] },
  ];

  for (const ver of versions) {
    for (const strat of strategies) {
      console.info(
        '[moneybird] ghl_contact_update_strategy_attempt',
        JSON.stringify({
          contactId,
          phase,
          strategy: strat.name,
          versionHeader: ver,
        })
      );
      try {
        const putRes = await fetchWithRetry(endpoint, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: ver,
          },
          body: JSON.stringify({ customFields: strat.fields }),
          _allowPostRetry: false,
        });
        const resText = await putRes.text().catch(() => '');
        const parsed = mbTryParseGhlJson(resText);
        const bodyOk = putRes.ok && mbGhlBodyIndicatesWriteOk(parsed);
        console.info(
          '[moneybird] ghl_contact_update_strategy_result',
          JSON.stringify({
            contactId,
            phase,
            strategy: strat.name,
            versionHeader: ver,
            httpStatus: putRes.status,
            bodyOk,
            responseBody: mbSummarizeGhlResponseText(resText, 600),
          })
        );
        if (!bodyOk) continue;
        const rb = await mbReadbackMoneybirdCustomFields({
          contactId,
          checks: [
            {
              name: 'moneybird_invoice_token',
              fieldId: id,
              fieldKey: key,
              expectedValue: v,
            },
          ],
          phase: `${phase}:strategy:${strat.name}`,
        });
        console.info(
          '[moneybird] ghl_contact_readback_after_strategy',
          JSON.stringify({
            contactId,
            strategy: strat.name,
            versionHeader: ver,
            readbackOk: rb.ok,
          })
        );
        if (rb.ok) return { ok: true, strategy: strat.name, versionUsed: ver, readback: rb };
      } catch (e) {
        console.warn(
          '[moneybird] ghl_contact_update_strategy_result',
          JSON.stringify({
            contactId,
            phase,
            strategy: strat.name,
            versionHeader: ver,
            error: e?.message || String(e),
          })
        );
      }
    }
  }
  return { ok: false, strategy: null, readback: null, versionUsed: null };
}

async function mbGhlContactPutWithLogs({
  contactId,
  customFields,
  phase,
  readbackChecks,
  resolvedFieldMap,
}) {
  const locationId = mbGhlLocationIdForLog();
  const endpoint = `${GHL_BASE}/contacts/${contactId}`;
  const normalized = mbNormalizeMoneybirdCustomFieldsForGhl(customFields);
  const bodyObj = { customFields: normalized };
  const logPayload =
    process.env.MONEYBIRD_GHL_LOG_FULL_FIELDS === '1'
      ? normalized
      : mbSummarizeCustomFieldsForLog(normalized);

  console.info(
    '[moneybird] ghl_contact_update_request',
    JSON.stringify({
      contactId,
      endpoint,
      method: 'PUT',
      versionHeader: '2021-04-15',
      resolvedFieldMap: resolvedFieldMap || undefined,
      customFields: logPayload,
      customFieldCount: normalized.length,
      locationId: locationId || undefined,
      phase,
    })
  );

  const doPut = async (version) =>
    fetchWithRetry(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version: version,
      },
      body: JSON.stringify(bodyObj),
      _allowPostRetry: false,
    });

  const evaluatePut = async (putRes, version) => {
    const resText = await putRes.text().catch(() => '');
    const parsed = mbTryParseGhlJson(resText);
    const bodySuccess = mbGhlBodyIndicatesWriteOk(parsed);
    const validationErrors =
      parsed?.meta?.errors ||
      parsed?.errors ||
      parsed?.validationErrors ||
      parsed?.error ||
      null;

    console.info(
      '[moneybird] ghl_contact_update_response',
      JSON.stringify({
        contactId,
        phase,
        versionHeader: version,
        httpStatus: putRes.status,
        responseBody: mbSummarizeGhlResponseText(resText, 800),
        bodySuccess: parsed && typeof parsed === 'object' && 'success' in parsed ? parsed.success : undefined,
        validationErrors:
          validationErrors != null
            ? mbSummarizeGhlResponseText(JSON.stringify(validationErrors), 500)
            : undefined,
      })
    );

    if (!putRes.ok) {
      console.error(
        '[moneybird] ghl_contact_update_failed',
        JSON.stringify({
          contactId,
          phase,
          versionHeader: version,
          httpStatus: putRes.status,
          responseBody: mbSummarizeGhlResponseText(resText, 800),
        })
      );
      return {
        ok: false,
        status: putRes.status,
        bodySnippet: mbSummarizeGhlResponseText(resText),
        readback: null,
        versionUsed: version,
      };
    }
    if (!bodySuccess) {
      console.error(
        '[moneybird] ghl_contact_update_failed',
        JSON.stringify({
          contactId,
          phase,
          versionHeader: version,
          httpStatus: putRes.status,
          reason: 'ghl_body_success_false',
          responseBody: mbSummarizeGhlResponseText(resText, 800),
        })
      );
      return {
        ok: false,
        status: putRes.status,
        bodySnippet: mbSummarizeGhlResponseText(resText),
        readback: null,
        versionUsed: version,
      };
    }

    let readback = null;
    if (Array.isArray(readbackChecks) && readbackChecks.length > 0) {
      readback = await mbReadbackMoneybirdCustomFields({ contactId, checks: readbackChecks, phase });
    }

    let effectiveReadbackOk = readback ? readback.ok : true;
    let versionUsed = version;
    let lastHttpStatus = putRes.status;

    if (readback && !readback.ok && version === '2021-04-15') {
      console.warn(
        '[moneybird] ghl_contact_put_retry_readback_mismatch',
        JSON.stringify({ contactId, phase, retryVersion: '2021-07-28' })
      );
      const putB = await doPut('2021-07-28');
      const resB = await putB.text().catch(() => '');
      const parsedB = mbTryParseGhlJson(resB);
      const bodySuccessB = mbGhlBodyIndicatesWriteOk(parsedB);
      console.info(
        '[moneybird] ghl_contact_update_response',
        JSON.stringify({
          contactId,
          phase,
          versionHeader: '2021-07-28',
          httpStatus: putB.status,
          responseBody: mbSummarizeGhlResponseText(resB, 800),
          bodySuccess:
            parsedB && typeof parsedB === 'object' && 'success' in parsedB ? parsedB.success : undefined,
          note: 'retry_after_readback_mismatch',
        })
      );
      if (!putB.ok || !bodySuccessB) {
        console.error(
          '[moneybird] ghl_contact_update_failed',
          JSON.stringify({
            contactId,
            phase,
            versionHeader: '2021-07-28',
            httpStatus: putB.status,
            reason: 'retry_put_failed',
          })
        );
        return {
          ok: false,
          status: putB.status,
          bodySnippet: mbSummarizeGhlResponseText(resB),
          readback,
          versionUsed: '2021-07-28',
        };
      }
      readback = await mbReadbackMoneybirdCustomFields({ contactId, checks: readbackChecks, phase });
      effectiveReadbackOk = readback ? readback.ok : true;
      versionUsed = '2021-07-28';
      lastHttpStatus = putB.status;
    }

    const combinedOk = effectiveReadbackOk;
    if (!combinedOk) {
      console.error(
        '[moneybird] ghl_contact_update_failed',
        JSON.stringify({
          contactId,
          phase,
          versionHeader: versionUsed,
          httpStatus: lastHttpStatus,
          reason: 'readback_missing_fields',
          readbackMissing: readback?.missing,
        })
      );
      return {
        ok: false,
        status: lastHttpStatus,
        bodySnippet: mbSummarizeGhlResponseText(resText),
        readback,
        versionUsed,
      };
    }

    console.info(
      '[moneybird] ghl_contact_update_success',
      JSON.stringify({
        contactId,
        httpStatus: lastHttpStatus,
        phase,
        versionHeader: versionUsed,
        readbackChecked: Boolean(readbackChecks && readbackChecks.length),
      })
    );
    return {
      ok: true,
      status: lastHttpStatus,
      bodySnippet: mbSummarizeGhlResponseText(resText),
      readback,
      versionUsed,
    };
  };

  try {
    const putRes = await doPut('2021-04-15');
    return await evaluatePut(putRes, '2021-04-15');
  } catch (e) {
    console.error(
      '[moneybird] ghl_contact_update_failed',
      JSON.stringify({
        contactId,
        message: e?.message || String(e),
        phase,
      })
    );
    return { ok: false, status: 0, bodySnippet: '', readback: null, versionUsed: '2021-04-15' };
  }
}

function mbInvoiceLooksAlreadySent(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  const sentAt = String(invoice.sent_at || invoice.sentAt || invoice.sent_on || '').trim();
  if (sentAt) return true;
  const state = String(invoice.state || invoice.status || '').trim().toLowerCase();
  if (!state) return false;
  return (
    state.includes('sent') ||
    state.includes('open') ||
    state.includes('paid') ||
    state.includes('late') ||
    state.includes('reminder')
  );
}

function mbInvoiceIsConcept(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  const state = String(invoice.state || invoice.status || '').trim().toLowerCase();
  if (!state) return false;
  return state.includes('draft') || state.includes('concept');
}

function mbInvoiceTotalNumber(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  const direct = [
    invoice.total_price_incl_tax,
    invoice.total_price_excl_tax,
    invoice.totalPriceInclTax,
    invoice.totalPrice,
  ];
  for (const v of direct) {
    const n = toPriceNumber(v);
    if (n !== null) return n;
  }
  const details = Array.isArray(invoice.details) ? invoice.details : (Array.isArray(invoice.details_attributes) ? invoice.details_attributes : []);
  if (!details.length) return null;
  let sum = 0;
  let has = false;
  for (const d of details) {
    const p = toPriceNumber(d?.price ?? d?.price_excl_tax ?? d?.price_incl_tax ?? d?.unit_price);
    const amount = toPriceNumber(d?.amount ?? 1);
    if (p === null) continue;
    const qty = amount === null ? 1 : amount;
    sum += Number(p) * Number(qty);
    has = true;
  }
  if (!has) return null;
  return Math.round(sum * 100) / 100;
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
  const bypass = String(process.env.DEV_LOGIN_BYPASS || '').toLowerCase() === 'true';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1');
  if (bypass && isLocalHost) return true;
  const token = req.headers['x-hk-auth'];
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: 'Niet ingelogd of sessie verlopen' });
    return false;
  }
  return true;
}

function normalizePhoneForGhl(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  let cleaned = input.replace(/[\s\-().]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    if (digits.startsWith('3106') && digits.length >= 11) {
      return `+31${digits.slice(3)}`;
    }
    return `+${digits}`;
  }
  const digits = cleaned.replace(/\D/g, '');
  if (digits.startsWith('06') && digits.length >= 10) {
    return `+31${digits.slice(1)}`;
  }
  if (digits.startsWith('31')) {
    if (digits.startsWith('3106') && digits.length >= 11) {
      return `+31${digits.slice(3)}`;
    }
    return `+${digits}`;
  }
  return digits;
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function phoneSearchVariants(raw) {
  const e164 = normalizePhoneForGhl(raw);
  if (!e164) return [];
  const digits = e164.replace(/\D/g, '');
  const variants = new Set();
  if (e164) variants.add(e164);
  if (digits) variants.add(digits);
  if (digits.startsWith('31') && digits.length >= 10) {
    variants.add(`0${digits.slice(2)}`);
  }
  if (digits.startsWith('06') && digits.length >= 10) {
    variants.add(`31${digits.slice(1)}`);
    variants.add(`+31${digits.slice(1)}`);
  }
  return [...variants].filter(Boolean);
}

function fallbackContactName(input = {}) {
  const name = String(input.name || '').trim();
  if (name) return name;
  const email = String(input.email || '').trim().toLowerCase();
  if (email.includes('@')) {
    const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    if (local) return local;
  }
  const phone = String(input.phone || '').trim();
  if (phone) return phone;
  return 'Onbekende klant';
}

export default async function handler(req, res) {
  applySecurityHeaders(res);
  const requestId = getOrCreateRequestId(req, res);
  if (!enforceSimpleRateLimit(req, res, 'ghl')) {
    logEvent('rate_limit_exceeded', { route: 'api/ghl', request_id: requestId }, 'warn');
    return res.status(429).json({ error: 'Te veel requests, probeer zo opnieuw.' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HK-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawAction = req.query?.action;
  const action = Array.isArray(rawAction) ? rawAction[0] : rawAction;
  logEvent('api_ghl_request', { action, method: req.method, request_id: requestId });

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
    const authTrace = process.env.HK_TRACE_AUTH === '1';
    if (authTrace) {
      console.log('[AUTH_TRACE][request]', {
        user: String(body.user || '').trim().toLowerCase() || null,
        hasPassword: !!String(body.password || ''),
      });
    }
    const u = String(body.user || '').trim().toLowerCase();
    const p = String(body.password || '');
    await new Promise((r) => setTimeout(r, 300));
    const users = parseUsers();
    if (authTrace) {
      console.log('[AUTH_TRACE][env_present]', {
        hasSessionSecret: !!process.env.SESSION_SECRET,
        hkUsersLen: String(process.env.HK_USERS || '').length,
        userKeys: Object.keys(users),
      });
    }
    if (!u || !users[u] || users[u] !== p) {
      if (authTrace) console.log('[AUTH_TRACE][fail]', { reason: 'bad_credentials' });
      return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
    }
    const token = signSessionToken(u);
    // `day` meesturen voor backward-compat met gecachte clients die nog de dagcheck doen
    const day = formatYyyyMmDdInAmsterdam(new Date()) || '';
    if (authTrace) console.log('[AUTH_TRACE][success]', { user: u, tokenLen: token?.length || 0 });
    return res.status(200).json({ token, user: u, day });
  }
  // ────────────────────────────────────────────────────────────────────────

  if (!requireAuth(req, res)) return;

  const locConfigured = ghlLocationIdFromEnv();
  const calConfigured = ghlCalendarIdFromEnv();
  if (!GHL_API_KEY || !locConfigured || !calConfigured) {
    return res.status(503).json({ error: GHL_CONFIG_MISSING_MSG });
  }

  async function routeMutationLockResponse(dateStr, mutationAction) {
    if (!isRouteLockStoreConfigured()) return null;
    const ds = normalizeYyyyMmDdInput(String(dateStr || ''));
    if (!ds) return null;
    const lock = await getRouteLock(locConfigured, ds);
    if (!lock || lock.locked !== true) return null;
    console.info(
      '[planner] route_mutation_blocked_due_to_lock',
      JSON.stringify({
        routeDate: ds,
        mutationAction: mutationAction || 'other',
        revision: Number.isFinite(Number(lock.revision)) ? Number(lock.revision) : null,
        orderLen: Array.isArray(lock.orderContactIds) ? lock.orderContactIds.length : 0,
      })
    );
    return res.status(409).json({
      error: 'Route is vastgezet. Ontgrendel de route voordat je deze afspraak wijzigt.',
      code: 'ROUTE_LOCKED',
      routeDate: ds,
      routeLock: {
        locked: true,
        revision: Number.isFinite(Number(lock.revision)) ? Number(lock.revision) : 0,
      },
    });
  }

  try {
    switch (action) {

      case 'getAppointments': {
        const plannerNotitiesFieldId = await resolvePlannerNotitiesFieldId();
        const plannerInternalFixedStartFieldId = await resolvePlannerInternalFixedStartFieldId();
        const invoicePartyFieldIdsForPlanner = await resolveInvoicePartyFieldIds({
          baseUrl: GHL_BASE,
          apiKey: GHL_API_KEY,
          locationId: ghlLocationIdFromEnv(),
        });
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
          const rawText = await response.text().catch(() => '');
          let data = {};
          try {
            data = rawText ? JSON.parse(rawText) : {};
          } catch {
            data = {};
          }
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
          const straat = splitCanon.straatnaam || '';
          const huisnr = splitCanon.huisnummer || '';
          const postcode =
            canonPostcode ||
            String(contact.postalCode || '')
              .replace(/\s+/g, ' ')
              .trim();
          const woonplaats = canonWoonplaats || contact.city || '';
          const fromCf     = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          const canonical  = readCanonicalAddressLine(contact);
          e.parsedAddress = canonical;
          if (_traceLastEditedContactId && String(contact?.id || '') === String(_traceLastEditedContactId)) {
            const traceFull = fromCf || canonical || '';
            console.log('[TRACE][mapped_address_after_edit]', {
              contactId: contact.id,
              straat_huisnummer: canonStreetHouse || null,
              postcode: canonPostcode || null,
              woonplaats: canonWoonplaats || null,
              address1: String(contact.address1 || '').trim() || null,
              fullAddressLine: traceFull || null,
            });
          }
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
          const plannerNotities = plannerNotitiesFieldId
            ? getField(contact, plannerNotitiesFieldId)
            : '';
          e.parsedNotes      = plannerNotities || getField(contact, FIELD_IDS.opmerkingen);
          e.parsedTimeWindow =
            getField(contact, BOOKING_FORM_FIELD_IDS.tijdslot) ||
            getField(contact, FIELD_IDS.tijdafspraak) ||
            null;
          const rawInternalFixed =
            plannerInternalFixedStartFieldId
              ? getField(contact, plannerInternalFixedStartFieldId, 'planner_internal_fixed_start')
              : '';
          const parsedInternalFixed = normalizeInternalFixedPinFromBody(rawInternalFixed);
          e.internalFixedPin = parsedInternalFixed;
          e.internalFixedStartTime = parsedInternalFixed?.time || '';
          try {
            console.info(
              '[planner] fixed_time_loaded',
              JSON.stringify({
                contactId: contact?.id ? String(contact.id) : null,
                appointmentId: e?.id ? String(e.id) : null,
                fieldId: plannerInternalFixedStartFieldId || null,
                hasValue: Boolean(parsedInternalFixed),
                pinType: parsedInternalFixed?.type || null,
                pinTime: parsedInternalFixed?.time || null,
              })
            );
          } catch (_) {}
          const confirmedDayPartRaw = String(
            getField(contact, BOOKING_FORM_FIELD_IDS.boeking_bevestigd_dagdeel) || ''
          )
            .trim()
            .toLowerCase();
          e.parsedConfirmedDayPart =
            confirmedDayPartRaw === 'morning' || confirmedDayPartRaw === 'afternoon'
              ? confirmedDayPartRaw
              : null;
          e.parsedConfirmedDate = String(
            getField(contact, BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum) || ''
          ).trim();
          e.parsedConfirmedStatus = String(
            getField(contact, BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status) || ''
          )
            .trim()
            .toLowerCase();
          e.parsedPaymentStatus = getField(contact, BOOKING_FORM_FIELD_IDS.betaal_status) || '';
          const canonPrijsRegels = getField(contact, BOOKING_FORM_FIELD_IDS.prijs_regels);
          let parsedPrijsRegels = parseStructuredPriceRulesString(canonPrijsRegels);
          if (parsedPrijsRegels.length === 0) {
            const prijsRegelsRaw = getField(contact, FIELD_IDS.prijs_regels);
            parsedPrijsRegels = parseStructuredPriceRulesString(prijsRegelsRaw);
          }
          e.parsedExtras = parsedPrijsRegels;
          e.invoiceFields = {
            factuurType: readInvoicePartyField(contact, 'factuur_type', invoicePartyFieldIdsForPlanner),
            factuurBedrijfsnaam: readInvoicePartyField(contact, 'factuur_bedrijfsnaam', invoicePartyFieldIdsForPlanner),
            factuurTav: readInvoicePartyField(contact, 'factuur_tav', invoicePartyFieldIdsForPlanner),
            factuurEmail: readInvoicePartyField(contact, 'factuur_email', invoicePartyFieldIdsForPlanner),
            factuurKvk: readInvoicePartyField(contact, 'factuur_kvk', invoicePartyFieldIdsForPlanner),
            factuurBtwNummer: readInvoicePartyField(contact, 'factuur_btw_nummer', invoicePartyFieldIdsForPlanner),
            factuurAdres: readInvoicePartyField(contact, 'factuur_adres', invoicePartyFieldIdsForPlanner),
            factuurPostcode: readInvoicePartyField(contact, 'factuur_postcode', invoicePartyFieldIdsForPlanner),
            factuurPlaats: readInvoicePartyField(contact, 'factuur_plaats', invoicePartyFieldIdsForPlanner),
            factuurReferentie: readInvoicePartyField(contact, 'factuur_referentie', invoicePartyFieldIdsForPlanner),
          };
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
        if (process.env.HK_DEBUG_PLANNER_ADDRESS === '1') {
          const traceRaw = req.query?.traceContactId;
          const traceCid = String(Array.isArray(traceRaw) ? traceRaw[0] : traceRaw || '').trim();
          if (traceCid) {
            const hit = appointments.find((a) => String(a.contactId || '') === traceCid);
            console.log('[getAppointments][mapped_address_after_edit]', {
              date,
              traceContactId: traceCid,
              found: !!hit,
              fullAddressLine: hit?.fullAddressLine ?? null,
              address: hit?.address ?? null,
            });
          }
        }
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
        const completionSamples = clientRows.slice(0, 8).map((a) => {
          const cid = String(a.contactId || '').trim();
          const c = cid ? contactMap[cid] : null;
          const datumRaw = c ? readContactCustomFieldById(c, LEGACY_COMPLETE_FIELD_IDS.datum_laatste_onderhoud) : '';
          const leg = c ? readContactCustomFieldById(c, LEGACY_COMPLETE_FIELD_IDS.legacy_betalingsstatus) : '';
          return {
            contactId: cid || null,
            appointmentId: String(a.id || ''),
            serviceDay: date,
            status: a.status,
            datumLen: datumRaw ? String(datumRaw).length : 0,
            datumMatchesRoute: plannerServiceMarkedCompleteOnRouteDay(datumRaw, date),
            legacyAfgerondLen: leg ? String(leg).length : 0,
            synthetic: !!a.isSyntheticBlockBooking,
          };
        });
        console.log(
          '[planner] completion_state_loaded',
          JSON.stringify({
            dateStr: date,
            klaarCount: nKlaarFromContact,
            clientRows: clientRows.length,
            sourceOfTruth:
              'GHL datum_laatste_onderhoud == routeDay (value|field_value); fallback betaal/legacy Afgerond zonder datum; browser localStorage cid:contact:day (niet verlopen)',
            samples: completionSamples,
          })
        );
        let customerDayFull = false;
        try {
          customerDayFull = await getCustomerDayFullFlag(locId, date);
        } catch (cfErr) {
          console.warn('[getAppointments] customerDayFull:', cfErr?.message || cfErr);
        }
        let routeLock = null;
        const routeLockStoreConfigured = isRouteLockStoreConfigured();
        if (routeLockStoreConfigured) {
          try {
            routeLock = await getRouteLock(locId, date);
          } catch (rlErr) {
            console.warn('[getAppointments] routeLock:', rlErr?.message || rlErr);
          }
        }
        return res.status(200).json({
          appointments,
          customerDayFull,
          customerDayFullStoreConfigured: isCustomerDayFullStoreConfigured(),
          routeLock,
          routeLockStoreConfigured,
        });
      }

      case 'setCustomerDayFull': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const dateCf = normalizeYyyyMmDdInput(String(req.body?.date || ''));
        if (!dateCf) return res.status(400).json({ error: 'date vereist (YYYY-MM-DD)' });
        const full =
          req.body?.full === true ||
          req.body?.full === 1 ||
          String(req.body?.full || '').toLowerCase() === 'true';
        if (!isCustomerDayFullStoreConfigured()) {
          return res.status(503).json({
            error:
              '“Dag is vol” gebruikt Upstash Redis. Zet UPSTASH_REDIS_REST_URL en UPSTASH_REDIS_REST_TOKEN op Vercel (zelfde als Model B-reserveringen).',
            code: 'NO_REDIS',
          });
        }
        const out = await setCustomerDayFullFlag(locConfigured, dateCf, full);
        if (!out.ok) {
          return res.status(400).json({ error: 'Kon dag-vol status niet opslaan', code: out.code || 'SAVE_FAILED' });
        }
        console.log(
          JSON.stringify({
            event: 'hk_customer_day_full',
            dateStr: dateCf,
            full,
            locationId: locConfigured,
          })
        );
        return res.status(200).json({ success: true, customerDayFull: full });
      }

      case 'searchAppointments': {
        const qRaw = String(req.query?.q || '').trim();
        const q = qRaw.toLowerCase();
        if (q.length < 2) {
          return res.status(200).json({ results: [] });
        }

        const locationId = ghlLocationIdFromEnv();
        const today = formatYyyyMmDdInAmsterdam(new Date());
        const startDate = addAmsterdamCalendarDays(today, -180);
        const endDate = addAmsterdamCalendarDays(today, 60);

        const contactsUrl = `${GHL_BASE}/contacts/` +
          `?locationId=${encodeURIComponent(locationId)}` +
          `&query=${encodeURIComponent(qRaw)}` +
          `&limit=20`;

        let contacts = [];
        try {
          const contactsRes = await fetchWithRetry(
            contactsUrl,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json',
                Version: '2021-04-15',
              },
            }
          );
          const contactsData = await contactsRes.json();
          contacts = Array.isArray(contactsData?.contacts)
            ? contactsData.contacts
            : [];
        } catch (err) {
          console.error('[search] contacts fetch error:', err);
          return res.status(200).json({ results: [] });
        }

        const out = [];
        for (const contact of contacts) {
          const cid = contact.id;
          if (!cid) continue;

          const reservations = await listReservationsForContact(cid);
          const filtered = reservations.filter((r) => {
            return r.dateStr >= startDate && r.dateStr <= endDate;
          });

          const name = [contact.firstName, contact.lastName]
            .filter(Boolean)
            .join(' ') || contact.name || '';
          const address = readCanonicalAddressLine(contact) || contact.address1 || '';

          if (filtered.length === 0) {
            out.push({
              id: `search:${cid}:no-appt`,
              contactId: cid,
              name,
              address,
              date: null,
              timeSlot: null,
              status: null,
              type: null,
            });
          } else {
            for (const r of filtered) {
              const blockLabel = r.block === 'morning'
                ? '09:00 - 13:00'
                : '13:00 - 17:00';
              out.push({
                id: `search:${cid}:${r.dateStr}:${r.block}`,
                contactId: cid,
                name,
                address,
                date: r.dateStr,
                timeSlot: blockLabel,
                status: 'confirmed',
                type: r.workType || null,
              });
            }
          }
        }

        return res.status(200).json({
          results: out.slice(0, 40),
        });
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

        pushField(FIELD_IDS.type_onderhoud, typeOnderhoud);
        pushField(FIELD_IDS.probleemomschrijving, probleemomschrijving);
        pushField(FIELD_IDS.tijdafspraak, tijdafspraak);
        pushField(FIELD_IDS.opmerkingen, opmerkingen);
        pushField(FIELD_IDS.prijs, prijs);
        const invoicePatch = {
          factuurType: req.body?.factuurType,
          factuurBedrijfsnaam: req.body?.factuurBedrijfsnaam,
          factuurTav: req.body?.factuurTav,
          factuurKvk: req.body?.factuurKvk,
          factuurBtwNummer: req.body?.factuurBtwNummer,
          factuurEmail: req.body?.factuurEmail,
          factuurAdres: req.body?.factuurAdres,
          factuurPostcode: req.body?.factuurPostcode,
          factuurPlaats: req.body?.factuurPlaats,
          factuurReferentie: req.body?.factuurReferentie,
        };
        const hasInvoicePatch = Object.values(invoicePatch).some((v) => v !== undefined && v !== null);
        if (hasInvoicePatch) {
          try {
            const invoiceIds = await resolveInvoicePartyFieldIds({
              baseUrl: GHL_BASE,
              apiKey: GHL_API_KEY,
              locationId: ghlLocationIdFromEnv(),
            });
            appendInvoicePartyWritesToCustomFields(customFields, invoiceIds, invoicePatch);
          } catch (invErr) {
            console.warn('[updateContactDashboard] invoice_party_fields_skip', invErr?.message || invErr);
          }
        }
        const canonStraatHuisnummer = [straatnaam, huisnummer]
          .map((x) => String(x || '').trim())
          .filter(Boolean)
          .join(' ');
        const bookingCanon = appendBookingCanonFields(customFields, {
          type_onderhoud: typeOnderhoud,
          probleemomschrijving,
          straat_huisnummer: canonStraatHuisnummer,
          postcode: String(postcode || '').trim(),
          woonplaats: String(woonplaats || '').trim(),
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
        const trimmedWoonplaats = String(woonplaats || '').trim();
        if (composedAddr) payload.address1 = composedAddr;
        if (trimmedWoonplaats) payload.city = trimmedWoonplaats;

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

        invalidateAmsterdamDayGhlReadCachesForDate({
          locationId: ghlLocationIdFromEnv(),
          calendarId: effectiveCalendarId(),
          dateStr: normalizeYyyyMmDdInput(String(routeDate || '')),
          trigger: 'updateContactDashboard',
        });

        return res.status(200).json({
          success: true,
          calendarSynced,
          calendarError: calendarError || undefined,
        });
      }

      case 'completeAppointment': {
        const { contactId, appointmentId, type, sendReview, lastService, totalPrice, extras, routeDate, basePrice, appointmentDesc } =
          req.body || {};
        if (!contactId) return res.status(400).json({ error: 'contactId vereist' });

        const {
          serviceDay,
          datumLaatsteOnderhoud,
          extrasNorm,
          canonicalPrijsRegels,
          canonicalPrijsTotaal,
          customFields,
        } = buildCompleteAppointmentPayload({
          routeDate,
          type,
          totalPrice,
          extras,
          lastService,
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
            datumLaatsteOnderhoudWritten: datumLaatsteOnderhoud,
            appointmentId: appointmentId != null ? String(appointmentId) : null,
            prijsTotaal: canonicalPrijsTotaal,
            prijsRegelsLines: extrasNorm.length,
          })
        );
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

        console.log(
          '[planner] completion_state_written',
          JSON.stringify({
            contactId,
            appointmentId: appointmentId != null ? String(appointmentId) : null,
            serviceDay: datumLaatsteOnderhoud,
            routeDateRequested: routeDate != null ? String(routeDate) : null,
            storedDatumLaatsteOnderhoud: datumLaatsteOnderhoud,
            storedLegacyBetalingsstatus: 'Afgerond',
            ghlContactPutOk: true,
          })
        );

        let moneybirdResult = null;
        // Moneybird factuur aanmaken (niet-fataal voor complete-flow)
        const MB_TOKEN = process.env.MONEYBIRD_API_TOKEN;
        const MB_ADMIN = process.env.MONEYBIRD_ADMINISTRATION_ID;
        if (MB_TOKEN && MB_ADMIN) {
          try {
            const {
              findOrCreateContact,
              findExistingInvoiceByReference,
              createSalesInvoice,
              getSalesInvoiceById,
              resolveSalesInvoicePaymentUrl,
              sendSalesInvoiceByEmail,
            } = await import('../lib/moneybird.js');
            const contactRes = await fetchWithRetry(
              `${GHL_BASE}/contacts/${contactId}`,
              {
                headers: {
                  Authorization: `Bearer ${GHL_API_KEY}`,
                  Version: '2021-04-15',
                },
              }
            );
            const contactData = await contactRes.json().catch(() => ({}));
            const contact = contactData?.contact || contactData;

            const invoicePartyFieldIds = await resolveInvoicePartyFieldIds({
              baseUrl: GHL_BASE,
              apiKey: GHL_API_KEY,
              locationId: ghlLocationIdFromEnv(),
            });
            const invoiceParty = buildInvoicePartyFromContact(contact, invoicePartyFieldIds, {
              contactId: String(contactId),
              appointmentId: String(appointmentId || ''),
            });

            const plannerNotitiesFieldId = await resolvePlannerNotitiesFieldId();
            const { invoiceIdFieldId, invoiceUrlFieldId, referenceFieldId, invoiceTokenFieldId } = await resolveMoneybirdFieldIds();
            console.info(
              '[moneybird] ghl_moneybird_field_id_map',
              JSON.stringify({
                contactId,
                appointmentId: String(appointmentId || ''),
                locationId: mbGhlLocationIdForLog() || undefined,
                moneybird_invoice_id: invoiceIdFieldId || null,
                moneybird_invoice_url: invoiceUrlFieldId || null,
                moneybird_invoice_reference: referenceFieldId || null,
                moneybird_invoice_token: invoiceTokenFieldId || null,
              })
            );

            const name = [contact.firstName, contact.lastName]
              .filter(Boolean).join(' ') || 'Klant';
            const email = contact.email || '';
            const phone = contact.phone || '';
            const address = readCanonicalAddressLine(contact) || contact.address1 || '';
            const moneybirdServiceDay =
              normalizeYyyyMmDdInput(String(serviceDay || '').trim()) ||
              normalizeYyyyMmDdInput(String(routeDate || '').trim()) ||
              formatYyyyMmDdInAmsterdam(new Date());
            const reference = buildMoneybirdReference({
              appointmentId,
              contactId,
              serviceDay: moneybirdServiceDay,
            });
            const description = `${type || 'Onderhoud'} - ${name}`;
            const descriptionForMb = `${description}${formatMoneybirdInvoiceMetadataSuffix(invoiceParty)}`;
            const logMb = (event, extra = {}, level = 'info') => {
              const payload = {
                contactId,
                appointmentId: String(appointmentId || ''),
                reference: reference || '',
                ...extra,
              };
              if (level === 'warn') console.warn(`[moneybird] ${event}`, payload);
              else if (level === 'error') console.error(`[moneybird] ${event}`, payload);
              else console.info(`[moneybird] ${event}`, payload);
            };

            const issueMoneybirdInvoicePayToken = async ({
              invoiceId,
              invoiceUrl,
              invoiceUrlSource,
              moneybirdResultRef,
            }) => {
              const invId = String(invoiceId || '').trim();
              const invUrl = String(invoiceUrl || '').trim();
              if (!invUrl) {
                logMb('invoice_token_missing_url', {
                  invoiceId: invId || undefined,
                  source: invoiceUrlSource || '',
                });
                return null;
              }
              if (!invId) {
                logMb('invoice_token_missing_invoice_id', {
                  source: invoiceUrlSource || '',
                }, 'warn');
                return null;
              }

              try {
                const mapping = await getOrCreateMoneybirdPayTokenMapping({
                  invoiceId: invId,
                  invoiceUrl: invUrl,
                  contactId: String(contactId || ''),
                  appointmentId: String(appointmentId || ''),
                  reference: String(reference || ''),
                });
                if (!mapping?.token) {
                  logMb('invoice_token_store_unavailable', {
                    invoiceId: invId,
                    source: invoiceUrlSource || '',
                  }, 'warn');
                  return null;
                }
                const payToken = mapping.token;
                if (mapping.reused) {
                  logMb('invoice_token_reused', {
                    invoiceId: invId,
                    token: payToken,
                    source: invoiceUrlSource || '',
                  });
                } else {
                  logMb('invoice_token_created', {
                    invoiceId: invId,
                    token: payToken,
                    source: invoiceUrlSource || '',
                  });
                }
                if (moneybirdResultRef && typeof moneybirdResultRef === 'object') {
                  moneybirdResultRef.invoicePayToken = payToken;
                  moneybirdResultRef.invoiceToken = payToken;
                }
                return payToken;
              } catch (e) {
                logMb('invoice_token_store_error', {
                  invoiceId: invId,
                  source: invoiceUrlSource || '',
                  message: e?.message || String(e),
                }, 'error');
                return null;
              }
            };

            const writeMoneybirdInvoiceTokenToGhl = async ({ invoiceId, payToken }) => {
              const invId = String(invoiceId || '').trim();
              const tok = String(payToken || '').trim();
              if (!tok) return false;
              if (!invoiceTokenFieldId) {
                logMb('invoice_token_field_missing', {
                  invoiceId: invId || undefined,
                  token: tok,
                }, 'warn');
                return false;
              }
              const fieldIdUsed = String(invoiceTokenFieldId || '').trim();
              let currentFieldValueBeforeWrite = '';
              try {
                const snap = await mbFetchContactAndGetField({
                  contactId,
                  fieldId: fieldIdUsed,
                  fieldKeyHint: 'moneybird_invoice_token',
                });
                currentFieldValueBeforeWrite = snap.value || '';
              } catch (preErr) {
                logMb('moneybird_invoice_token_prefetch_failed', {
                  invoiceId: invId || undefined,
                  message: preErr?.message || String(preErr),
                }, 'warn');
              }
              logMb('moneybird_invoice_token_write_context', {
                invoiceId: invId || undefined,
                fieldId: fieldIdUsed,
                currentFieldValueBeforeWrite,
                attemptedToken: tok,
              });
              const logReadbackOutcome = async (via) => {
                try {
                  const after = await mbFetchContactAndGetField({
                    contactId,
                    fieldId: fieldIdUsed,
                    fieldKeyHint: 'moneybird_invoice_token',
                  });
                  logMb('moneybird_invoice_token_write_readback', {
                    invoiceId: invId || undefined,
                    fieldId: fieldIdUsed,
                    via,
                    valueBeforeWrite: currentFieldValueBeforeWrite,
                    valueAfterWrite: after.value,
                    matchesAttempted: after.value === tok,
                  });
                } catch (rbErr) {
                  logMb('moneybird_invoice_token_post_readback_failed', {
                    invoiceId: invId || undefined,
                    message: rbErr?.message || String(rbErr),
                  }, 'warn');
                }
              };
              const put = await mbGhlContactPutWithLogs({
                contactId,
                customFields: [{ id: fieldIdUsed, field_value: tok }],
                phase: 'moneybird_invoice_token_only',
                readbackChecks: [
                  {
                    name: 'moneybird_invoice_token',
                    fieldId: fieldIdUsed,
                    fieldKey: 'moneybird_invoice_token',
                    expectedValue: tok,
                  },
                ],
                resolvedFieldMap: { moneybird_invoice_token: fieldIdUsed },
              });
              if (put.ok) {
                await logReadbackOutcome('primary_put');
                return true;
              }
              await logReadbackOutcome('after_primary_failed');
              logMb('invoice_token_ghl_write_primary_failed', {
                invoiceId: invId || undefined,
                token: tok,
                status: put.status,
                detail: put.bodySnippet,
                readbackReason: put.readback && !put.readback.ok ? 'readback_missing_fields' : undefined,
              }, 'warn');
              const strat = await mbTryMoneybirdInvoiceTokenWriteStrategies({
                contactId,
                fieldId: fieldIdUsed,
                fieldKey: 'moneybird_invoice_token',
                tok,
                phase: 'moneybird_invoice_token_only',
              });
              if (!strat.ok) {
                logMb('invoice_token_ghl_write_failed', {
                  invoiceId: invId || undefined,
                  token: tok,
                  reason: 'all_strategies_failed',
                }, 'warn');
                return false;
              }
              logMb('invoice_token_ghl_write_strategy_recovered', {
                invoiceId: invId || undefined,
                token: tok,
                strategy: strat.strategy,
                version: strat.versionUsed,
              });
              await logReadbackOutcome(`strategy:${strat.strategy}`);
              return true;
            };

            const pulseMoneybirdPaymentWhatsapp = async ({
              invoiceId,
              invoiceUrl,
              invoiceUrlSource,
              payToken,
              tokenPersistedOk,
              readbackOk,
              moneybirdResultRef,
            }) => {
              const invId = String(invoiceId || '').trim();
              const invUrl = String(invoiceUrl || '').trim();
              const tok = String(payToken || '').trim();
              if (!tok) {
                return;
              }
              if (!invoiceTokenFieldId) {
                logMb('invoice_token_field_missing', {
                  invoiceId: invId || undefined,
                  token: tok,
                }, 'warn');
                return;
              }
              if (!invUrl) {
                logMb('missing_invoice_url', {
                  invoiceId: invId || undefined,
                  token: tok || undefined,
                  source: invoiceUrlSource || '',
                });
                return;
              }
              if (tokenPersistedOk === false) {
                logMb('whatsapp_send_failed', {
                  invoiceId: invId || undefined,
                  token: tok,
                  source: invoiceUrlSource || '',
                  reason: 'token_not_persisted_in_ghl',
                }, 'error');
                return;
              }
              if (readbackOk === false) {
                logMb('whatsapp_send_failed', {
                  invoiceId: invId || undefined,
                  token: tok,
                  source: invoiceUrlSource || '',
                  reason: 'ghl_readback_failed',
                }, 'error');
                return;
              }
              const phoneNorm = normalizePhoneForGhl(phone);
              if (!phoneNorm) {
                logMb('missing_phone', {
                  invoiceId: invId || undefined,
                  token: tok || undefined,
                  source: invoiceUrlSource || '',
                });
                return;
              }
              const tagHooks = {
                on: (event, payload) => {
                  console.info(`[moneybird] ${event}`, JSON.stringify(payload));
                },
              };
              try {
                const waTagOk = await pulseContactTag(
                  contactId,
                  'stuur-betaallink',
                  '[moneybird whatsapp]',
                  tagHooks
                );
                if (!waTagOk) {
                  logMb('whatsapp_send_failed', {
                    invoiceId: invId || undefined,
                    token: tok,
                    source: invoiceUrlSource || '',
                    reason: 'ghl_tag_pulse_failed',
                  }, 'error');
                  return;
                }
                logMb('whatsapp_payment_link_sent', {
                  invoiceId: invId || undefined,
                  token: tok || undefined,
                  source: invoiceUrlSource || '',
                });
                if (moneybirdResultRef && typeof moneybirdResultRef === 'object') {
                  moneybirdResultRef.whatsappSent = true;
                }
              } catch (waErr) {
                logMb('whatsapp_send_failed', {
                  invoiceId: invId || undefined,
                  token: tok || undefined,
                  source: invoiceUrlSource || '',
                  message: waErr?.message || String(waErr),
                  reason: 'exception',
                }, 'error');
              }
            };

            const extrasLines = normalizePriceLineItems(Array.isArray(extras) ? extras : []);
            const baseFromReq = toPriceNumber(basePrice);
            const extrasSum = Math.round(extrasLines.reduce((s, r) => s + Number(r.price || 0), 0) * 100) / 100;
            const totalNum = toPriceNumber(totalPrice);
            const baseFromDiff = totalNum !== null ? Math.round((totalNum - extrasSum) * 100) / 100 : null;
            const effectiveBase = baseFromReq !== null
              ? baseFromReq
              : (baseFromDiff !== null && baseFromDiff > 0 ? baseFromDiff : null);
            const baseDesc = String(appointmentDesc || type || 'Werkzaamheden').trim();
            const lines = [
              ...(effectiveBase && effectiveBase > 0 ? [{ desc: baseDesc, price: effectiveBase }] : []),
              ...extrasLines,
            ].filter((l) => l.desc && Number(l.price) > 0);

            const linesSum = Math.round(lines.reduce((s, r) => s + Number(r.price || 0), 0) * 100) / 100;
            if (totalNum !== null && Math.abs(linesSum - totalNum) > 0.01) {
              console.warn('[moneybird] regel-som wijkt af van totalPrice', {
                contactId,
                appointmentId: String(appointmentId || ''),
                linesSum,
                totalPrice: totalNum,
              });
            }

            const existingId = invoiceIdFieldId ? getField(contact, invoiceIdFieldId) : '';
            const existingUrl = invoiceUrlFieldId ? getField(contact, invoiceUrlFieldId) : '';
            const existingRef = referenceFieldId ? getField(contact, referenceFieldId) : '';
            const existingNote = plannerNotitiesFieldId ? getField(contact, plannerNotitiesFieldId) : '';
            const noteMarker = parseMoneybirdInvoiceFromPlannerNotes(existingNote);

            if (lines.length > 0) {
              const existingRefToUse = existingRef || noteMarker.reference;
              const existingInvoiceId = existingId || noteMarker.invoiceId;
              const existingInvoiceUrl = existingUrl || noteMarker.invoiceUrl;
              const existingMatchesCurrent =
                !reference || (existingRefToUse && existingRefToUse === reference);
              if (existingInvoiceId && existingMatchesCurrent) {
                console.info('[moneybird] factuur overgeslagen: al gekoppeld in GHL', {
                  contactId,
                  appointmentId: String(appointmentId || ''),
                  invoiceId: existingInvoiceId,
                  reference: existingRefToUse || reference,
                });
                moneybirdResult = {
                  skipped: true,
                  reason: 'already_linked',
                  invoiceId: existingInvoiceId,
                  invoiceUrl: existingInvoiceUrl,
                  invoiceUrlSource: existingInvoiceUrl ? 'stored-metadata' : '',
                };
                logMb('invoice_reused', {
                  invoiceId: existingInvoiceId,
                  source: existingInvoiceUrl ? 'stored-metadata' : '',
                });
                const payTokenAlready = await issueMoneybirdInvoicePayToken({
                  invoiceId: existingInvoiceId,
                  invoiceUrl: existingInvoiceUrl,
                  invoiceUrlSource: existingInvoiceUrl ? 'stored-metadata' : '',
                  moneybirdResultRef: moneybirdResult,
                });
                if (payTokenAlready) {
                  const tokenWritten = await writeMoneybirdInvoiceTokenToGhl({
                    invoiceId: existingInvoiceId,
                    payToken: payTokenAlready,
                  });
                  if (tokenWritten) {
                    await pulseMoneybirdPaymentWhatsapp({
                      invoiceId: existingInvoiceId,
                      invoiceUrl: existingInvoiceUrl,
                      invoiceUrlSource: existingInvoiceUrl ? 'stored-metadata' : '',
                      payToken: payTokenAlready,
                      tokenPersistedOk: true,
                      readbackOk: true,
                      moneybirdResultRef: moneybirdResult,
                    });
                  }
                }
              } else {
                const existingByRef = reference
                  ? await findExistingInvoiceByReference(reference)
                  : { found: false, invoice: null };

                if (existingByRef?.found && existingByRef?.invoice?.id) {
                  const foundInvoiceId = String(existingByRef.invoice.id);
                  const foundInvoiceResolved = resolveSalesInvoicePaymentUrl(existingByRef.invoice);
                  const foundInvoiceUrl = foundInvoiceResolved.url || existingByRef.invoice?.url || existingByRef.invoice?.public_view_url || '';
                  console.info('[moneybird] duplicate-skip reference', { reference });
                  console.info('[moneybird] factuur overgeslagen: referentie bestaat al', {
                    contactId,
                    appointmentId: String(appointmentId || ''),
                    reference,
                    invoiceId: foundInvoiceId,
                  });
                  logMb('invoice_reused', {
                    invoiceId: foundInvoiceId,
                    source: foundInvoiceResolved.source || (foundInvoiceUrl ? 'query-result' : ''),
                  });
                  moneybirdResult = {
                    skipped: true,
                    reason: 'reference_exists',
                    invoiceId: foundInvoiceId,
                    invoiceUrl: foundInvoiceUrl,
                    invoiceUrlSource: foundInvoiceResolved.source || (foundInvoiceUrl ? 'query-result' : ''),
                  };
                  const payTokenRef = await issueMoneybirdInvoicePayToken({
                    invoiceId: foundInvoiceId,
                    invoiceUrl: foundInvoiceUrl,
                    invoiceUrlSource: foundInvoiceResolved.source || (foundInvoiceUrl ? 'query-result' : ''),
                    moneybirdResultRef: moneybirdResult,
                  });
                  if (payTokenRef) {
                    const tokenWrittenRef = await writeMoneybirdInvoiceTokenToGhl({
                      invoiceId: foundInvoiceId,
                      payToken: payTokenRef,
                    });
                    if (tokenWrittenRef) {
                      await pulseMoneybirdPaymentWhatsapp({
                        invoiceId: foundInvoiceId,
                        invoiceUrl: foundInvoiceUrl,
                        invoiceUrlSource: foundInvoiceResolved.source || (foundInvoiceUrl ? 'query-result' : ''),
                        payToken: payTokenRef,
                        tokenPersistedOk: true,
                        readbackOk: true,
                        moneybirdResultRef: moneybirdResult,
                      });
                    }
                  }
                } else {
                  const mbContact = await findOrCreateContact(name, email, phone, address, { invoiceParty });
                  if (!mbContact?.contactId) {
                    console.warn('[moneybird] factuur overgeslagen: geen match/create contact', {
                      contactId,
                      appointmentId: String(appointmentId || ''),
                      reason: mbContact?.reason || 'missing_contact',
                    });
                    moneybirdResult = { skipped: true, reason: mbContact?.reason || 'missing_contact' };
                  } else {
                    console.info(mbContact.created ? '[moneybird] contact aangemaakt' : '[moneybird] contact gematcht', {
                      contactId,
                      appointmentId: String(appointmentId || ''),
                      mbContactId: mbContact.contactId,
                    });
                    const created = await createSalesInvoice({
                      contactId: mbContact.contactId,
                      lines,
                      reference,
                      description: descriptionForMb,
                    });
                    if (created?.created && created?.invoice?.id) {
                      const invoiceId = String(created.invoice.id);
                      const resolvedFromCreate = resolveSalesInvoicePaymentUrl(created.invoice);
                      let invoiceUrl = resolvedFromCreate.url;
                      let invoiceUrlSource = resolvedFromCreate.url ? 'create-response' : '';
                      if (!invoiceUrl) {
                        try {
                          const invoiceRead = await getSalesInvoiceById(invoiceId);
                          const resolvedFromRead = resolveSalesInvoicePaymentUrl(invoiceRead?.invoice);
                          if (resolvedFromRead.url) {
                            invoiceUrl = resolvedFromRead.url;
                            invoiceUrlSource = 'read-call';
                          }
                        } catch (_) {}
                      }
                      const invoiceNumber = String(created.invoice?.invoice_id || '').trim() || null;
                      console.info('[moneybird] factuur aangemaakt (concept)', {
                        contactId,
                        appointmentId: String(appointmentId || ''),
                        reference,
                        invoiceId,
                        invoiceNumber,
                        invoiceUrl,
                        invoiceUrlSource,
                      });
                      moneybirdResult = {
                        created: true,
                        invoiceId,
                        invoiceUrl,
                        invoiceUrlSource,
                        invoiceNumber,
                        reference,
                      };
                      logMb('invoice_created', {
                        invoiceId,
                        source: invoiceUrlSource || '',
                      });
                      if (invoiceUrlSource === 'url') {
                        logMb('payment_url_missing_using_url_fallback', {
                          invoiceId,
                          source: 'url',
                        }, 'warn');
                      }

                      // Veilige default: alleen bij nieuw aangemaakte factuur automatisch e-mail versturen.
                      const emailNorm = String(
                        mbContact?.contact?.email || email || ''
                      )
                        .trim()
                        .toLowerCase();
                      const hasValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
                      if (!hasValidEmail) {
                        console.info('[moneybird] invoice_send_skipped_missing_email', {
                          contactId,
                          appointmentId: String(appointmentId || ''),
                          invoiceId,
                        });
                      } else {
                        console.info('[moneybird] invoice_send_ready_after_contact_sync', {
                          contactId,
                          appointmentId: String(appointmentId || ''),
                          invoiceId,
                          moneybirdContactId: String(mbContact?.contactId || ''),
                        });
                        try {
                          const mailResult = await sendSalesInvoiceByEmail({
                            invoiceId,
                            emailAddress: emailNorm,
                            emailMessage: `Beste ${name}, hierbij ontvang je je factuur.`,
                          });
                          if (mailResult?.sent) {
                            console.info('[moneybird] invoice email sent', {
                              contactId,
                              appointmentId: String(appointmentId || ''),
                              invoiceId,
                              email: emailNorm,
                            });
                            moneybirdResult.emailSent = true;
                          } else if (mailResult?.reason === 'missing_email') {
                            console.info('[moneybird] invoice_send_skipped_missing_email', {
                              contactId,
                              appointmentId: String(appointmentId || ''),
                              invoiceId,
                            });
                          }
                        } catch (mailErr) {
                          console.error('[moneybird] email_send_failed', {
                            contactId,
                            appointmentId: String(appointmentId || ''),
                            invoiceId,
                            email: emailNorm,
                            message: mailErr?.message || String(mailErr),
                            status: mailErr?.status,
                          });
                        }
                      }

                      const payTokenCreate = await issueMoneybirdInvoicePayToken({
                        invoiceId,
                        invoiceUrl,
                        invoiceUrlSource,
                        moneybirdResultRef: moneybirdResult,
                      });

                      const mbFields = [];
                      if (invoiceIdFieldId) mbFields.push({ id: invoiceIdFieldId, field_value: invoiceId });
                      if (invoiceUrlFieldId && invoiceUrl) mbFields.push({ id: invoiceUrlFieldId, field_value: invoiceUrl });
                      if (referenceFieldId && reference) mbFields.push({ id: referenceFieldId, field_value: reference });
                      // moneybird_invoice_token: niet in batch — aparte single-field PUT + readback
                      // voorkomt dat een mislukte readback op url/id/reference de token overslaat.
                      if (plannerNotitiesFieldId) {
                        const nextNotes = appendMoneybirdPlannerNote(existingNote, {
                          invoiceId,
                          reference,
                          invoiceUrl,
                        });
                        if (nextNotes) mbFields.push({ id: plannerNotitiesFieldId, field_value: nextNotes });
                      }
                      const mbResolvedFieldMap = {
                        moneybird_invoice_id: invoiceIdFieldId || null,
                        moneybird_invoice_url: invoiceUrlFieldId || null,
                        moneybird_invoice_reference: referenceFieldId || null,
                        moneybird_invoice_token: invoiceTokenFieldId || null,
                      };
                      const mbReadbackChecks = [];
                      if (invoiceIdFieldId && invoiceId) {
                        mbReadbackChecks.push({
                          name: 'moneybird_invoice_id',
                          fieldId: invoiceIdFieldId,
                          fieldKey: 'moneybird_invoice_id',
                          expectedValue: invoiceId,
                        });
                      }
                      if (invoiceUrlFieldId && invoiceUrl) {
                        mbReadbackChecks.push({
                          name: 'moneybird_invoice_url',
                          fieldId: invoiceUrlFieldId,
                          fieldKey: 'moneybird_invoice_url',
                          expectedValue: invoiceUrl,
                        });
                      }
                      if (referenceFieldId && reference) {
                        mbReadbackChecks.push({
                          name: 'moneybird_invoice_reference',
                          fieldId: referenceFieldId,
                          fieldKey: 'moneybird_invoice_reference',
                          expectedValue: reference,
                        });
                      }

                      let mbMetadataSaved = mbFields.length === 0;
                      let mbPutResult = { ok: true, readback: null };
                      if (mbFields.length > 0) {
                        mbPutResult = await mbGhlContactPutWithLogs({
                          contactId,
                          customFields: mbFields,
                          phase: 'moneybird_invoice_metadata_batch',
                          readbackChecks: mbReadbackChecks,
                          resolvedFieldMap: mbResolvedFieldMap,
                        });
                        mbMetadataSaved = mbPutResult.ok;
                        if (!mbPutResult.ok) {
                          console.warn('[moneybird] metadata niet opgeslagen in GHL', {
                            contactId,
                            appointmentId: String(appointmentId || ''),
                            status: mbPutResult.status,
                            detail: mbPutResult.bodySnippet,
                          });
                        }
                      }

                      let tokenDedicatedWriteOk = true;
                      if (payTokenCreate && invoiceTokenFieldId) {
                        tokenDedicatedWriteOk = await writeMoneybirdInvoiceTokenToGhl({
                          invoiceId,
                          payToken: payTokenCreate,
                        });
                      } else if (payTokenCreate && !invoiceTokenFieldId) {
                        tokenDedicatedWriteOk = false;
                      }

                      const allowWhatsappPaymentPulse =
                        Boolean(payTokenCreate && invoiceUrl) && tokenDedicatedWriteOk;

                      if (allowWhatsappPaymentPulse) {
                        await pulseMoneybirdPaymentWhatsapp({
                          invoiceId,
                          invoiceUrl,
                          invoiceUrlSource,
                          payToken: payTokenCreate || '',
                          tokenPersistedOk: tokenDedicatedWriteOk,
                          readbackOk: tokenDedicatedWriteOk,
                          moneybirdResultRef: moneybirdResult,
                        });
                      } else if (payTokenCreate && !tokenDedicatedWriteOk) {
                        logMb('whatsapp_skipped_metadata_write_failed', {
                          invoiceId,
                          token: payTokenCreate,
                          source: invoiceUrlSource || '',
                          reason: 'dedicated_token_write_failed',
                        }, 'warn');
                      }
                    } else {
                      moneybirdResult = { skipped: true, reason: created?.reason || 'invoice_not_created' };
                    }
                  }
                }
              }
            } else {
              moneybirdResult = { skipped: true, reason: 'no_billable_lines' };
            }
          } catch (err) {
            // Niet fataal — factuur mislukt stopt niet de klaar-flow
            console.error('[moneybird] factuur error:', {
              contactId,
              appointmentId: String(appointmentId || ''),
              message: err?.message || String(err),
              status: err?.status,
              details: err?.details,
            });
          }
        }

        const tagErrors = [];
        const tagOk = await addTag(contactId, 'factuur-versturen').catch((e) => {
          tagErrors.push(e.message);
          return false;
        });
        const reviewAutomation = await ensureReviewMailTagOnComplete({
          contactId,
          appointmentId: appointmentId || null,
          sendReview: sendReview === true,
          status: 'klaar',
          fetchImpl: fetchWithRetry,
          apiKey: GHL_API_KEY,
          locationId: GHL_LOCATION_ID,
          baseUrl: process.env.GHL_BASE_URL || GHL_BASE,
          tagName: REVIEW_MAIL_TAG,
        });
        if (reviewAutomation?.error) {
          tagErrors.push(`review_tag:${reviewAutomation.error}`);
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
          reviewAutomation,
          // Altijd key meesturen (ook `null`) zodat clients betrouwbaar kunnen detecteren
          // of Moneybird überhaupt een outcome heeft teruggegeven.
          moneybird: moneybirdResult,
        });
      }

      case 'retryInvoice': {
        const { contactId, appointmentId, type, totalPrice, extras, routeDate, basePrice, appointmentDesc } =
          req.body || {};
        if (!contactId) return res.status(400).json({ error: 'contactId vereist' });
        const MB_TOKEN = process.env.MONEYBIRD_API_TOKEN;
        const MB_ADMIN = process.env.MONEYBIRD_ADMINISTRATION_ID;
        if (!MB_TOKEN || !MB_ADMIN) {
          return res.status(503).json({ error: 'Moneybird niet geconfigureerd' });
        }
        const logRetry = (event, extra = {}, level = 'info') => {
          const payload = {
            contactId,
            appointmentId: String(appointmentId || ''),
            ...extra,
          };
          if (level === 'warn') console.warn(`[moneybird] ${event}`, payload);
          else if (level === 'error') console.error(`[moneybird] ${event}`, payload);
          else console.info(`[moneybird] ${event}`, payload);
        };
        try {
          const {
            findOrCreateContact,
            findExistingInvoiceByReference,
            createSalesInvoice,
            updateSalesInvoiceDraft,
            getSalesInvoiceById,
            resolveSalesInvoicePaymentUrl,
            sendSalesInvoiceByEmail,
          } = await import('../lib/moneybird.js');
          const contactRes = await fetchWithRetry(
            `${GHL_BASE}/contacts/${contactId}`,
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: '2021-04-15',
              },
            }
          );
          const contactData = await contactRes.json().catch(() => ({}));
          const contact = contactData?.contact || contactData;
          const invoicePartyFieldIds = await resolveInvoicePartyFieldIds({
            baseUrl: GHL_BASE,
            apiKey: GHL_API_KEY,
            locationId: ghlLocationIdFromEnv(),
          });
          const invoiceParty = buildInvoicePartyFromContact(contact, invoicePartyFieldIds, {
            contactId: String(contactId),
            appointmentId: String(appointmentId || ''),
          });
          const plannerNotitiesFieldId = await resolvePlannerNotitiesFieldId();
          const { invoiceIdFieldId, invoiceUrlFieldId, referenceFieldId, invoiceTokenFieldId } = await resolveMoneybirdFieldIds();
          const name = [contact.firstName, contact.lastName]
            .filter(Boolean).join(' ') || 'Klant';
          const email = contact.email || '';
          const phone = contact.phone || '';
          const address = readCanonicalAddressLine(contact) || contact.address1 || '';
          const serviceDay =
            normalizeYyyyMmDdInput(String(routeDate || '').trim()) ||
            formatYyyyMmDdInAmsterdam(new Date());
          const reference = buildMoneybirdReference({
            appointmentId,
            contactId,
            serviceDay,
          });
          logRetry('invoice_retry_started', { reference });
          logRetry('invoice_retry_confirmed', { reference });
          const extrasLines = normalizePriceLineItems(Array.isArray(extras) ? extras : []);
          const baseFromReq = toPriceNumber(basePrice);
          const extrasSum = Math.round(extrasLines.reduce((s, r) => s + Number(r.price || 0), 0) * 100) / 100;
          const totalNum = toPriceNumber(totalPrice);
          const baseFromDiff = totalNum !== null ? Math.round((totalNum - extrasSum) * 100) / 100 : null;
          const effectiveBase = baseFromReq !== null
            ? baseFromReq
            : (baseFromDiff !== null && baseFromDiff > 0 ? baseFromDiff : null);
          const baseDesc = String(appointmentDesc || type || 'Werkzaamheden').trim();
          const lines = [
            ...(effectiveBase && effectiveBase > 0 ? [{ desc: baseDesc, price: effectiveBase }] : []),
            ...extrasLines,
          ].filter((l) => l.desc && Number(l.price) > 0);
          if (lines.length === 0) {
            return res.status(200).json({
              success: true,
              actionTaken: 'no_billable_lines',
              message: 'Geen factureerbare regels beschikbaar.',
            });
          }
          const existingId = invoiceIdFieldId ? getField(contact, invoiceIdFieldId) : '';
          const existingUrl = invoiceUrlFieldId ? getField(contact, invoiceUrlFieldId) : '';
          const existingRef = referenceFieldId ? getField(contact, referenceFieldId) : '';
          const existingNote = plannerNotitiesFieldId ? getField(contact, plannerNotitiesFieldId) : '';
          const noteMarker = parseMoneybirdInvoiceFromPlannerNotes(existingNote);
          const existingRefToUse = existingRef || noteMarker.reference;
          const existingInvoiceId = existingId || noteMarker.invoiceId;
          let invoice = null;
          let invoiceId = '';
          let invoiceUrl = '';
          let invoiceUrlSource = '';
          let actionTaken = 'unknown';
          const mbContact = await findOrCreateContact(name, email, phone, address, { invoiceParty });
          if (!mbContact?.contactId) {
            return res.status(200).json({
              success: true,
              actionTaken: 'missing_contact',
              message: 'Factuur kon niet verzonden worden',
            });
          }
          if (existingInvoiceId && (!reference || existingRefToUse === reference)) {
            const byId = await getSalesInvoiceById(existingInvoiceId).catch(() => ({ found: false, invoice: null }));
            if (byId?.found && byId?.invoice) {
              invoice = byId.invoice;
              invoiceId = String(invoice.id);
              const resolved = resolveSalesInvoicePaymentUrl(invoice);
              invoiceUrl = resolved.url || existingUrl || '';
              invoiceUrlSource = resolved.source || (existingUrl ? 'stored-metadata' : '');
              actionTaken = 'reused_existing';
              logRetry('invoice_retry_reused_existing', { reference, invoiceId, actionTaken });
            }
          }
          if (!invoice && reference) {
            const existingByRef = await findExistingInvoiceByReference(reference);
            if (existingByRef?.found && existingByRef?.invoice?.id) {
              invoice = existingByRef.invoice;
              invoiceId = String(invoice.id);
              const resolved = resolveSalesInvoicePaymentUrl(invoice);
              invoiceUrl = resolved.url || '';
              invoiceUrlSource = resolved.source || (invoiceUrl ? 'query-result' : '');
              actionTaken = 'reused_existing';
              logRetry('invoice_retry_reused_existing', { reference, invoiceId, actionTaken });
            }
          }
          if (!invoice) {
            const description = `${type || 'Onderhoud'} - ${name}${formatMoneybirdInvoiceMetadataSuffix(invoiceParty)}`;
            const created = await createSalesInvoice({
              contactId: mbContact.contactId,
              lines,
              reference,
              description,
            });
            if (!created?.created || !created?.invoice?.id) {
              return res.status(200).json({
                success: true,
                actionTaken: 'create_failed',
                message: 'Factuur kon niet verzonden worden',
              });
            }
            invoice = created.invoice;
            invoiceId = String(invoice.id);
            const resolved = resolveSalesInvoicePaymentUrl(invoice);
            invoiceUrl = resolved.url || '';
            invoiceUrlSource = resolved.source || (invoiceUrl ? 'create-response' : '');
            actionTaken = 'created_new';
            logRetry('invoice_retry_created_new', { reference, invoiceId, actionTaken });
          }
          const currentTotal = Math.round(lines.reduce((s, r) => s + Number(r.price || 0), 0) * 100) / 100;
          const invoiceTotal = mbInvoiceTotalNumber(invoice);
          const totalsDiffer =
            invoiceTotal !== null &&
            Math.abs(Number(invoiceTotal) - Number(currentTotal)) > 0.01;
          const invoiceIsConcept = mbInvoiceIsConcept(invoice);
          const invoiceAlreadySent = mbInvoiceLooksAlreadySent(invoice);
          if (invoiceAlreadySent && totalsDiffer) {
            actionTaken = 'blocked_sent_price_mismatch';
            logRetry(
              'invoice_retry_blocked_price_mismatch_sent_invoice',
              {
                reference,
                invoiceId,
                invoiceTotal,
                currentTotal,
                actionTaken,
              },
              'warn'
            );
            return res.status(200).json({
              success: true,
              actionTaken,
              message:
                'De factuur is al verzonden en het bedrag in de app is gewijzigd. Pas de factuur handmatig aan in Moneybird of maak een correctie.',
              invoiceId: invoiceId || null,
              reference: reference || null,
            });
          }
          if (invoiceIsConcept && totalsDiffer) {
            const description = `${type || 'Onderhoud'} - ${name}${formatMoneybirdInvoiceMetadataSuffix(invoiceParty)}`;
            const upd = await updateSalesInvoiceDraft({
              invoiceId,
              lines,
              reference,
              description,
            });
            if (upd?.updated && upd?.invoice) {
              invoice = upd.invoice;
              actionTaken = 'concept_updated';
              logRetry('invoice_retry_concept_updated_before_send', {
                reference,
                invoiceId,
                invoiceTotalBefore: invoiceTotal,
                currentTotal,
              });
            }
          }
          const mbFields = [];
          if (invoiceIdFieldId && invoiceId) mbFields.push({ id: invoiceIdFieldId, field_value: invoiceId });
          if (invoiceUrlFieldId && invoiceUrl) mbFields.push({ id: invoiceUrlFieldId, field_value: invoiceUrl });
          if (referenceFieldId && reference) mbFields.push({ id: referenceFieldId, field_value: reference });
          if (plannerNotitiesFieldId && invoiceId && reference) {
            const nextNotes = appendMoneybirdPlannerNote(existingNote, { invoiceId, reference, invoiceUrl });
            if (nextNotes) mbFields.push({ id: plannerNotitiesFieldId, field_value: nextNotes });
          }
          if (mbFields.length > 0) {
            await mbGhlContactPutWithLogs({
              contactId,
              customFields: mbFields,
              phase: 'moneybird_invoice_retry_metadata_batch',
              readbackChecks: [],
              resolvedFieldMap: {
                moneybird_invoice_id: invoiceIdFieldId || null,
                moneybird_invoice_url: invoiceUrlFieldId || null,
                moneybird_invoice_reference: referenceFieldId || null,
              },
            });
          }
          const latestInvoiceRead = await getSalesInvoiceById(invoiceId).catch(() => ({ found: false, invoice: null }));
          const latestInvoice = latestInvoiceRead?.invoice || invoice;
          const alreadySent = mbInvoiceLooksAlreadySent(latestInvoice);
          const emailNorm = String(
            mbContact?.contact?.email || email || ''
          ).trim().toLowerCase();
          const hasValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm);
          let hadWhatsapp = false;
          let emailSentNow = false;
          if (alreadySent) {
            actionTaken = 'already_sent_noop';
            logRetry('invoice_retry_noop_already_sent', { reference, invoiceId, actionTaken, hadEmail: hasValidEmail });
          } else if (hasValidEmail) {
            const mailResult = await sendSalesInvoiceByEmail({
              invoiceId,
              emailAddress: emailNorm,
              emailMessage: `Beste ${name}, hierbij ontvang je je factuur.`,
            }).catch(() => ({ sent: false }));
            if (mailResult?.sent) {
              emailSentNow = true;
              actionTaken =
                actionTaken === 'created_new'
                  ? 'created_and_sent_email'
                  : actionTaken === 'concept_updated'
                    ? 'concept_updated_and_sent'
                    : 'reused_and_sent_email';
              logRetry('invoice_retry_sent_email', { reference, invoiceId, hadEmail: true, actionTaken });
            }
          } else {
            actionTaken = 'missing_email';
          }
          let payToken = '';
          if (invoiceId && invoiceUrl) {
            const mapping = await getOrCreateMoneybirdPayTokenMapping({
              invoiceId,
              invoiceUrl,
              contactId: String(contactId || ''),
              appointmentId: String(appointmentId || ''),
              reference: String(reference || ''),
            }).catch(() => null);
            payToken = String(mapping?.token || '').trim();
          }
          if (payToken && invoiceTokenFieldId) {
            const tokenPut = await mbGhlContactPutWithLogs({
              contactId,
              customFields: [{ id: invoiceTokenFieldId, field_value: payToken }],
              phase: 'moneybird_invoice_retry_token_only',
              readbackChecks: [
                {
                  name: 'moneybird_invoice_token',
                  fieldId: invoiceTokenFieldId,
                  fieldKey: 'moneybird_invoice_token',
                  expectedValue: payToken,
                },
              ],
              resolvedFieldMap: { moneybird_invoice_token: invoiceTokenFieldId },
            });
            if (tokenPut.ok) {
              try {
                const waTagOk = await pulseContactTag(
                  contactId,
                  'stuur-betaallink',
                  '[moneybird whatsapp retry]',
                  { on: () => {} }
                );
                if (waTagOk) {
                  hadWhatsapp = true;
                  logRetry('invoice_retry_sent_whatsapp', { reference, invoiceId, actionTaken: 'whatsapp_sent' });
                  if (!emailSentNow) actionTaken = 'whatsapp_sent';
                }
              } catch (_) {}
            }
          }
          const messageByAction = {
            created_and_sent_email: 'Factuur aangemaakt en verzonden',
            reused_and_sent_email: 'Bestaande factuur opnieuw verzonden',
            concept_updated_and_sent: 'Conceptfactuur bijgewerkt en verzonden',
            already_sent_noop: 'Factuur bestond al en was al verzonden',
            blocked_sent_price_mismatch:
              'De factuur is al verzonden en het bedrag in de app is gewijzigd. Pas de factuur handmatig aan in Moneybird of maak een correctie.',
            missing_email: 'Geen e-mailadres beschikbaar',
            whatsapp_sent: 'WhatsApp opnieuw verstuurd',
            created_new: 'Factuur aangemaakt',
            reused_existing: 'Bestaande factuur hergebruikt',
          };
          return res.status(200).json({
            success: true,
            actionTaken,
            message: messageByAction[actionTaken] || 'Factuur retry afgerond',
            invoiceId: invoiceId || null,
            reference: reference || null,
            hadEmail: hasValidEmail,
            hadWhatsapp,
          });
        } catch (err) {
          logRetry(
            'invoice_retry_failed',
            {
              message: err?.message || String(err),
              status: err?.status || null,
            },
            'error'
          );
          return res.status(500).json({ error: 'Factuur kon niet verzonden worden' });
        }
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

      case 'setInternalFixedStart': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const cid = String(req.body?.contactId || '').trim();
        const routeDate = normalizeYyyyMmDdInput(String(req.body?.routeDate || ''));
        if (!cid) return res.status(400).json({ error: 'contactId vereist' });
        const fieldId = await resolvePlannerInternalFixedStartFieldId();
        if (!fieldId) {
          console.warn(
            '[planner] fixed_time_missing_bug',
            JSON.stringify({
              reason: 'planner_internal_fixed_start_field_not_configured',
              contactId: cid,
              routeDate: routeDate || null,
            })
          );
          return res.status(503).json({
            error: 'planner_internal_fixed_start custom field ontbreekt in GHL',
            code: 'MISSING_INTERNAL_FIXED_FIELD',
          });
        }
        const pin = normalizeInternalFixedPinFromBody(req.body?.internalFixedStart);
        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify({
            customFields: [{ id: fieldId, field_value: pin ? JSON.stringify(pin) : '' }],
          }),
          _allowPostRetry: false,
        });
        if (!putRes.ok) {
          const detail = (await putRes.text().catch(() => '')).slice(0, 400);
          return res.status(502).json({ error: 'Kon vaste tijd niet opslaan in GHL', detail });
        }
        console.info(
          '[planner] fixed_time_saved',
          JSON.stringify({
            contactId: cid,
            appointmentId: req.body?.appointmentId ? String(req.body.appointmentId) : null,
            routeDate: routeDate || null,
            fieldId,
            pinType: pin?.type || null,
            pinTime: pin?.time || null,
          })
        );
        return res.status(200).json({ success: true, internalFixedStart: pin || null });
      }

      case 'updatePlannerBookingDetails': {
        const {
          contactId,
          name,
          phone,
          email,
          address,
          date,
          slotKey,
          slotLabel,
          type,
          desc,
          price,
          priceLines,
        } = req.body || {};
        console.log('[TRACE][request_body]', req.body);
        if (process.env.HK_DEBUG_PLANNER_ADDRESS === '1') {
          console.log('[updatePlannerBookingDetails][request_body]', {
            keys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
            contactId: contactId != null ? String(contactId) : null,
            addressLen: String(address || '').trim().length,
            date: date != null ? String(date) : null,
          });
        }
        console.log('[updatePlannerBookingDetails][start]', {
          hasBody: !!req.body,
          contactId: contactId != null ? String(contactId) : null,
          date: date != null ? String(date) : null,
          slotKey: slotKey != null ? String(slotKey) : null,
          hasName: !!String(name || '').trim(),
          hasPhone: !!String(phone || '').trim(),
          hasEmail: !!String(email || '').trim(),
          hasAddress: !!String(address || '').trim(),
          hasPriceLines: Array.isArray(priceLines) && priceLines.length > 0,
        });
        const cid = String(contactId || '').trim();
        if (!cid) return res.status(400).json({ error: 'contactId vereist' });
        const dateNorm = normalizeYyyyMmDdInput(String(date || ''));
        if (!dateNorm) return res.status(400).json({ error: 'date verplicht (YYYY-MM-DD)' });
        const lockRes = await routeMutationLockResponse(dateNorm, 'updatePlannerBookingDetails');
        if (lockRes) return lockRes;
        if (plannerBodyIncludesInvoiceKeys(req.body || {})) {
          const ftInv = normalizePlannerInvoiceTypeFromBody(req.body?.factuurType);
          if (ftInv === 'bedrijf' && !String(req.body?.factuurBedrijfsnaam || '').trim()) {
            return res.status(400).json({ error: 'Bij factuurtype Bedrijf is bedrijfsnaam verplicht.' });
          }
        }

        const nameNorm = String(name || '').trim() || 'Onbekende klant';
        const nameParts = nameNorm.split(/\s+/).filter(Boolean);
        const firstName = nameParts[0] || nameNorm;
        const lastName = nameParts.slice(1).join(' ');
        const phoneNorm = normalizePhoneForGhl(phone);
        const emailNorm = String(email || '').trim().toLowerCase();
        const addressNorm = String(address || '').trim();
        console.log('[TRACE][normalized_address]', addressNorm);
        if (process.env.HK_DEBUG_PLANNER_ADDRESS === '1') {
          console.log('[updatePlannerBookingDetails][normalized_address]', {
            contactId: cid,
            addressNorm: addressNorm.slice(0, 200),
          });
        }
        const workTypeNorm = normalizeWorkType(type || '');
        const descNorm = String(desc || '').trim();
        const slotPart = slotKey === 'afternoon' ? 'afternoon' : 'morning';
        const slotLabelNorm =
          String(slotLabel || '').trim() ||
          (slotPart === 'afternoon' ? SLOT_LABEL_AFTERNOON_NL : SLOT_LABEL_MORNING_NL);
        const normalizedLines = normalizePriceLineItems(Array.isArray(priceLines) ? priceLines : []);
        const totalFromLines = normalizedLines.length
          ? Math.round(normalizedLines.reduce((sum, row) => sum + Number(row.price || 0), 0) * 100) / 100
          : null;
        const totalNum = totalFromLines ?? toPriceNumber(price);
        const linesForCanon = normalizedLines.length
          ? normalizedLines
          : totalNum !== null
            ? [{ desc: descNorm || 'Handmatige afspraak', price: totalNum }]
            : [];
        const structuredPriceRules = formatPriceRulesStructuredString(linesForCanon);
        const plannerNotitiesFieldId = await resolvePlannerNotitiesFieldId();
        const plannerInternalFixedStartFieldId = await resolvePlannerInternalFixedStartFieldId();
        const plannerNotitiesRaw = req.body?.notities ?? req.body?.plannerNotities ?? descNorm ?? '';
        const plannerNotitiesNorm = String(plannerNotitiesRaw).trim();
        const internalFixedPinRaw = req.body?.internalFixedStart;
        const internalFixedPin = normalizeInternalFixedPinFromBody(internalFixedPinRaw);
        console.log('[updatePlannerBookingDetails][normalized]', {
          contactId: cid,
          dateNorm,
          slotPart,
          slotLabelNorm,
          workTypeNorm,
          normalizedLines: normalizedLines.length,
          totalNum,
          structuredPriceRulesLen: structuredPriceRules.length,
        });

        const { address1, customFields: addrCf, parts } = buildCanonicalAddressWritePayload(addressNorm);
        /** Zelfde boekingsformulier-CF als confirm-booking, anders blijft getAppointments oude straat/postcode/plaats tonen. */
        const streetHouseLine = [parts.straatnaam, parts.huisnummer]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        const bookingStraatHuis =
          streetHouseLine ||
          (addressNorm ? String(address1 || addressNorm).replace(/\s+/g, ' ').trim() : '');
        const customFields = [
          ...addrCf,
          { id: FIELD_IDS.type_onderhoud, field_value: workTypeNorm || 'reparatie' },
          { id: FIELD_IDS.probleemomschrijving, field_value: descNorm || '' },
          { id: FIELD_IDS.tijdafspraak, field_value: slotLabelNorm || '' },
          { id: FIELD_IDS.prijs_regels, field_value: JSON.stringify(linesForCanon) },
        ];
        if (plannerNotitiesFieldId && plannerNotitiesNorm) {
          customFields.push({ id: plannerNotitiesFieldId, field_value: plannerNotitiesNorm });
        }
        if (plannerInternalFixedStartFieldId && req.body && Object.prototype.hasOwnProperty.call(req.body, 'internalFixedStart')) {
          customFields.push({
            id: plannerInternalFixedStartFieldId,
            field_value: internalFixedPin ? JSON.stringify(internalFixedPin) : '',
          });
          console.info(
            '[planner] fixed_time_saved',
            JSON.stringify({
              contactId: cid,
              appointmentId: null,
              routeDate: dateNorm,
              fieldId: plannerInternalFixedStartFieldId,
              pinType: internalFixedPin?.type || null,
              pinTime: internalFixedPin?.time || null,
            })
          );
        }
        if (totalNum !== null) {
          customFields.push({ id: FIELD_IDS.prijs, field_value: String(totalNum) });
        }
        console.log('[updatePlannerBookingDetails][booking_fields_ok]', {
          contactId: cid,
          customFieldCountBeforeCanon: customFields.length,
        });
        const bookingCanon = appendBookingCanonFields(customFields, {
          straat_huisnummer: bookingStraatHuis,
          postcode: parts.postcode || '',
          woonplaats: parts.woonplaats || '',
          type_onderhoud: workTypeNorm || 'reparatie',
          probleemomschrijving: descNorm || '',
          tijdslot: slotLabelNorm || '',
          prijs_totaal: totalNum,
          prijs_regels: structuredPriceRules,
          boeking_bevestigd_datum: dateNorm,
          boeking_bevestigd_dagdeel: slotPart,
          boeking_bevestigd_status: 'confirmed',
        });
        if (addressNorm) {
          if (!String(parts.postcode || '').trim()) {
            bookingCanon.customFields.push({
              id: BOOKING_FORM_FIELD_IDS.postcode,
              value: '',
              field_value: '',
            });
          }
          if (!String(parts.woonplaats || '').trim()) {
            bookingCanon.customFields.push({
              id: BOOKING_FORM_FIELD_IDS.woonplaats,
              value: '',
              field_value: '',
            });
          }
        }
        await appendPlannerInvoicePartyFieldsToCustomFields(bookingCanon.customFields, req.body);
        const payload = {
          firstName,
          lastName,
          customFields: bookingCanon.customFields,
        };
        if (phoneNorm) payload.phone = phoneNorm;
        if (emailNorm) payload.email = emailNorm;
        if (address1) payload.address1 = address1;
        if (addressNorm) mergeGhlNativeAddressFromParts(payload, parts);
        if (process.env.HK_DEBUG_PLANNER_ADDRESS === '1') {
          console.log('[updatePlannerBookingDetails][address_write]', {
            contactId: cid,
            addressNorm,
            address1,
            parts,
            bookingStraatHuis,
            bookingFormPostcode: parts.postcode || '(cleared)',
            bookingFormWoonplaats: parts.woonplaats || '(cleared)',
          });
        }
        console.log('[updatePlannerBookingDetails][contact_update_start]', {
          contactId: cid,
          hasPhone: !!payload.phone,
          hasEmail: !!payload.email,
          hasAddress1: !!payload.address1,
          customFieldCount: bookingCanon.customFields.length,
        });
        logCanonicalAddressWrite('updatePlannerBookingDetails', {
          contactId: cid,
          address1: address1 || null,
        });
        console.log('[TRACE][write_payload]', payload);
        const logContactAddressReadBack = async (label) => {
          try {
            const rr = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
              headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
            });
            const raw = await rr.text().catch(() => '');
            let contact = null;
            try {
              const j = JSON.parse(raw);
              contact = j?.contact || j;
            } catch (_) {}
            console.log(label, {
              httpOk: rr.ok,
              address1: contact?.address1 ?? null,
              straat_huisnummer: getField(contact, BOOKING_FORM_FIELD_IDS.straat_huisnummer),
              postcode: getField(contact, BOOKING_FORM_FIELD_IDS.postcode),
              woonplaats: getField(contact, BOOKING_FORM_FIELD_IDS.woonplaats),
            });
          } catch (e) {
            console.log(label, { error: String(e?.message || e) });
          }
        };
        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify(payload),
          _allowPostRetry: false,
        });
        const putText = await putRes.text().catch(() => '');
        console.log('[TRACE][ghl_put_status]', putRes.status);
        console.log('[TRACE][ghl_put_response]', putText.slice(0, 500));
        if (!putRes.ok) {
          const detail = putText.slice(0, 400);
          console.error('[updatePlannerBookingDetails][contact_update_fail]', {
            contactId: cid,
            status: putRes.status,
            detail,
          });
          // Concrete hardening: fallback zonder phone/email wanneer GHL deze payloadvelden afkeurt.
          const fallbackPayload = {
            firstName,
            lastName,
            customFields: bookingCanon.customFields,
            ...(address1 ? { address1 } : {}),
          };
          if (addressNorm) mergeGhlNativeAddressFromParts(fallbackPayload, parts);
          console.log('[updatePlannerBookingDetails][contact_update_retry_start]', {
            contactId: cid,
            customFieldCount: bookingCanon.customFields.length,
            hasAddress1: !!address1,
          });
          const retryRes = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Version: '2021-04-15',
            },
            body: JSON.stringify(fallbackPayload),
            _allowPostRetry: false,
          });
          const retryText = await retryRes.text().catch(() => '');
          console.log('[TRACE][ghl_put_status_retry]', retryRes.status);
          console.log('[TRACE][ghl_put_response_retry]', retryText.slice(0, 500));
          if (!retryRes.ok) {
            const retryDetail = retryText.slice(0, 400);
            console.error('[updatePlannerBookingDetails][booking_fields_fail]', {
              contactId: cid,
              status: retryRes.status,
              detail: retryDetail,
            });
            return res.status(502).json({
              error: 'Contact/boekingsvelden bijwerken mislukt',
              detail: retryDetail || detail,
            });
          }
          _traceLastEditedContactId = cid;
          await logContactAddressReadBack('[TRACE][address_after_write_immediate]');
          await new Promise((r) => setTimeout(r, 2000));
          await logContactAddressReadBack('[TRACE][address_after_write_delayed]');
          console.log('[updatePlannerBookingDetails][contact_update_ok]', {
            contactId: cid,
            mode: 'fallback_without_phone_email',
          });
          invalidateRedisSyntheticsCacheForDate(dateNorm);
          invalidateAmsterdamDayGhlReadCachesForDate({
            locationId: ghlLocationIdFromEnv(),
            calendarId: effectiveCalendarId(),
            dateStr: dateNorm,
            trigger: 'updatePlannerBookingDetails',
          });
          console.log('[updatePlannerBookingDetails][done]', {
            contactId: cid,
            date: dateNorm,
            slotKey: slotPart,
            warning: 'phone/email omitted in fallback',
          });
          return res.status(200).json({
            success: true,
            contactId: cid,
            date: dateNorm,
            slotKey: slotPart,
            warning: 'Contactvelden opgeslagen zonder phone/email (fallback na GHL validatie).',
          });
        }
        _traceLastEditedContactId = cid;
        await logContactAddressReadBack('[TRACE][address_after_write_immediate]');
        await new Promise((r) => setTimeout(r, 2000));
        await logContactAddressReadBack('[TRACE][address_after_write_delayed]');
        console.log('[updatePlannerBookingDetails][contact_update_ok]', {
          contactId: cid,
          mode: 'primary',
        });
        invalidateRedisSyntheticsCacheForDate(dateNorm);
        invalidateAmsterdamDayGhlReadCachesForDate({
          locationId: ghlLocationIdFromEnv(),
          calendarId: effectiveCalendarId(),
          dateStr: dateNorm,
          trigger: 'updatePlannerBookingDetails',
        });
        console.log('[updatePlannerBookingDetails][done]', {
          contactId: cid,
          date: dateNorm,
          slotKey: slotPart,
        });
        return res.status(200).json({
          success: true,
          contactId: cid,
          date: dateNorm,
          slotKey: slotPart,
        });
      }

      case 'saveRouteTimes': {
        // Custom field geplande aankomst + optioneel GHL-kalender bijwerken
        const { routeTimes, routeLock } = req.body; // routeLock: { dateStr, locked, orderContactIds, etasByContactId, updatedBy? }
        if (!Array.isArray(routeTimes) || routeTimes.length === 0) {
          return res.status(400).json({ error: 'routeTimes array vereist' });
        }
        let routeLockSaved = false;
        let routeLockState = null;
        if (routeLock && typeof routeLock === 'object') {
          const lockDate = normalizeYyyyMmDdInput(String(routeLock.dateStr || ''));
          if (!lockDate) {
            return res.status(400).json({ error: 'routeLock.dateStr vereist (YYYY-MM-DD)' });
          }
          if (!isRouteLockStoreConfigured()) {
            return res.status(503).json({
              error:
                'Route-lock gebruikt Upstash Redis. Zet UPSTASH_REDIS_REST_URL en UPSTASH_REDIS_REST_TOKEN op Vercel.',
              code: 'NO_ROUTE_LOCK_STORE',
            });
          }
          console.info('[planner] route_lock_write_started', JSON.stringify({
            routeDate: lockDate,
            expectedRevision: routeLock.expectedRevision ?? null,
            locked: routeLock.locked === true,
            orderLen: Array.isArray(routeLock.orderContactIds) ? routeLock.orderContactIds.length : 0,
          }));
          const lockWrite = await setRouteLock(locConfigured, lockDate, routeLock);
          if (!lockWrite.ok && lockWrite.code === 'REVISION_CONFLICT') {
            console.warn('[planner] route_lock_revision_conflict', JSON.stringify({
              routeDate: lockDate,
              expectedRevision: routeLock.expectedRevision ?? null,
              currentRevision: lockWrite.currentLock?.revision ?? null,
            }));
            return res.status(409).json({
              error: 'Route is intussen gewijzigd, laad opnieuw.',
              code: 'ROUTE_LOCK_REVISION_CONFLICT',
              currentLock: lockWrite.currentLock || null,
            });
          }
          if (!lockWrite.ok) {
            console.error('[planner] route_lock_write_failed', JSON.stringify({
              routeDate: lockDate,
              code: lockWrite.code || 'ROUTE_LOCK_SAVE_FAILED',
            }));
            return res.status(400).json({ error: 'Kon route-lock niet opslaan', code: lockWrite.code || 'ROUTE_LOCK_SAVE_FAILED' });
          }
          routeLockSaved = true;
          routeLockState = lockWrite.lock;
          console.info('[planner] route_lock_write_committed', JSON.stringify({
            routeDate: lockDate,
            revision: routeLockState?.revision ?? null,
            orderChecksum: routeLockState?.orderChecksum || null,
            locked: !!routeLockState?.locked,
          }));
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
          routeLockSaved,
          routeLock: routeLockState || undefined,
        });
      }

      case 'setRouteLock': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!isRouteLockStoreConfigured()) {
          return res.status(503).json({
            error:
              'Route-lock gebruikt Upstash Redis. Zet UPSTASH_REDIS_REST_URL en UPSTASH_REDIS_REST_TOKEN op Vercel.',
            code: 'NO_ROUTE_LOCK_STORE',
          });
        }
        const dateStr = normalizeYyyyMmDdInput(String(req.body?.date || req.body?.dateStr || ''));
        if (!dateStr) return res.status(400).json({ error: 'date vereist (YYYY-MM-DD)' });
        const routeLock = req.body?.routeLock && typeof req.body.routeLock === 'object'
          ? req.body.routeLock
          : { locked: false };
        console.info('[planner] route_lock_write_started', JSON.stringify({
          routeDate: dateStr,
          expectedRevision: routeLock.expectedRevision ?? null,
          locked: routeLock.locked === true,
          orderLen: Array.isArray(routeLock.orderContactIds) ? routeLock.orderContactIds.length : 0,
        }));
        const out = await setRouteLock(locConfigured, dateStr, {
          ...routeLock,
          dateStr,
        });
        if (!out.ok && out.code === 'REVISION_CONFLICT') {
          console.warn('[planner] route_lock_revision_conflict', JSON.stringify({
            routeDate: dateStr,
            expectedRevision: routeLock.expectedRevision ?? null,
            currentRevision: out.currentLock?.revision ?? null,
          }));
          return res.status(409).json({
            error: 'Route is intussen gewijzigd, laad opnieuw.',
            code: 'ROUTE_LOCK_REVISION_CONFLICT',
            currentLock: out.currentLock || null,
          });
        }
        if (!out.ok) {
          console.error('[planner] route_lock_write_failed', JSON.stringify({
            routeDate: dateStr,
            code: out.code || 'ROUTE_LOCK_SAVE_FAILED',
          }));
          return res.status(400).json({ error: 'Kon route-lock niet opslaan', code: out.code || 'ROUTE_LOCK_SAVE_FAILED' });
        }
        console.info('[planner] route_lock_write_committed', JSON.stringify({
          routeDate: dateStr,
          revision: out.lock?.revision ?? null,
          orderChecksum: out.lock?.orderChecksum || null,
          locked: !!out.lock?.locked,
        }));
        return res.status(200).json({
          success: true,
          dateStr,
          routeLock: out.lock,
          routeLockStoreConfigured: true,
        });
      }

      case 'createAppointment': {
        const {
          name,
          phone,
          email,
          address,
          date,
          time,
          type: apptType,
          desc,
          contactId: existingContactId,
          price,
          priceLines,
          slotKey,
          slotLabel,
          timeWindow,
        } = req.body || {};
        const nameNormRaw = String(name || '').trim();
        const emailNorm = String(email || '').trim().toLowerCase();
        const addressNorm = String(address || '').trim();
        const phoneNorm = normalizePhoneForGhl(phone);
        const nameNorm = fallbackContactName({
          name: nameNormRaw,
          email: emailNorm,
          phone: phoneNorm,
        });
        const dateNorm = normalizeYyyyMmDdInput(String(date || ''));
        const timeNorm = String(time || '').trim();
        if (!addressNorm) return res.status(400).json({ error: 'address verplicht' });
        if (!dateNorm) return res.status(400).json({ error: 'date verplicht (YYYY-MM-DD)' });
        if (!/^\d{2}:\d{2}$/.test(timeNorm)) return res.status(400).json({ error: 'time verplicht (HH:mm)' });
        const lockRes = await routeMutationLockResponse(dateNorm, 'createAppointment');
        if (lockRes) return lockRes;
        if (plannerBodyIncludesInvoiceKeys(req.body || {})) {
          const ftInv = normalizePlannerInvoiceTypeFromBody(req.body?.factuurType);
          if (ftInv === 'bedrijf' && !String(req.body?.factuurBedrijfsnaam || '').trim()) {
            return res.status(400).json({ error: 'Bij factuurtype Bedrijf is bedrijfsnaam verplicht.' });
          }
        }
        const normalizedLines = normalizePriceLineItems(Array.isArray(priceLines) ? priceLines : []);
        const slotLabelNorm =
          slotKey === 'afternoon'
            ? SLOT_LABEL_AFTERNOON_NL
            : slotKey === 'morning'
              ? SLOT_LABEL_MORNING_NL
              : String(slotLabel || timeWindow || '').trim();
        const slotPart =
          slotKey === 'afternoon' || slotKey === 'morning'
            ? slotKey
            : String(timeNorm || '').startsWith('13:')
              ? 'afternoon'
              : 'morning';
        const priceNumFromLines = normalizedLines.length
          ? Math.round(normalizedLines.reduce((sum, row) => sum + Number(row.price || 0), 0) * 100) / 100
          : null;
        const priceNum = priceNumFromLines ?? toPriceNumber(price);
        const plannerNotitiesFieldId = await resolvePlannerNotitiesFieldId();
        const plannerInternalFixedStartFieldId = await resolvePlannerInternalFixedStartFieldId();
        const plannerNotitiesRaw = req.body?.notities ?? req.body?.plannerNotities ?? desc ?? '';
        const plannerNotitiesNorm = String(plannerNotitiesRaw).trim();
        const internalFixedPinRaw = req.body?.internalFixedStart;
        const internalFixedPin = normalizeInternalFixedPinFromBody(internalFixedPinRaw);

        // Stap 1: contact resolven via upsert -> duplicate search -> force create
        const readResolvedContactId = (payload) =>
          payload?.contact?.id || payload?.id || payload?.data?.contact?.id || null;
        let contactId = String(existingContactId || '').trim() || null;
        let contactResolution = contactId ? 'existing_contact_id' : '';
        if (!contactId) {
          const nameParts = nameNorm.split(' ');
          const upsertPayload = {
            locationId: GHL_LOCATION_ID,
            firstName: nameParts[0] || nameNorm,
            lastName: nameParts.slice(1).join(' ') || '',
          };
          if (phoneNorm) upsertPayload.phone = phoneNorm;
          if (emailNorm) upsertPayload.email = emailNorm;
          if (addressNorm) upsertPayload.address1 = addressNorm;
          // city alleen meesturen als afleidbaar uit adresregel (laatste segment na komma).
          const cityFromAddress = addressNorm.includes(',')
            ? String(addressNorm.split(',').pop() || '').trim()
            : '';
          if (cityFromAddress) upsertPayload.city = cityFromAddress;

          // 1) Upsert op phone/email
          if (phoneNorm || emailNorm) {
            const upsertRes = await fetchWithRetry(`${GHL_BASE}/contacts/upsert`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
              body: JSON.stringify(upsertPayload),
            });
            if (upsertRes.ok) {
              const upsertData = await upsertRes.json().catch(() => ({}));
              contactId = readResolvedContactId(upsertData);
              if (contactId) contactResolution = 'upsert';
            }
          }

          // 2) Duplicate search op genormaliseerde phone
          if (!contactId && phoneNorm) {
            const searchRes = await fetchWithRetry(
              `${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(phoneNorm)}`,
              { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json().catch(() => ({}));
              contactId = readResolvedContactId(searchData);
              if (contactId) contactResolution = 'duplicate_search';
            }
          }

          // 3) Force create als er nog geen contact is
          if (!contactId) {
            const createPayload = {
              locationId: GHL_LOCATION_ID,
              firstName: nameParts[0] || nameNorm || 'Onbekend',
            };
            const createLastName = nameParts.slice(1).join(' ').trim();
            if (createLastName) createPayload.lastName = createLastName;
            if (phoneNorm) createPayload.phone = phoneNorm;
            if (emailNorm) createPayload.email = emailNorm;
            if (addressNorm) createPayload.address1 = addressNorm;
            if (cityFromAddress) createPayload.city = cityFromAddress;

            console.log('[createAppointment][contact_create_payload]', {
              hasPhone: !!createPayload.phone,
              hasEmail: !!createPayload.email,
              hasAddress1: !!createPayload.address1,
              hasCity: !!createPayload.city,
              firstName: createPayload.firstName,
              lastName: createPayload.lastName || '',
            });
            const createRes = await fetchWithRetry(`${GHL_BASE}/contacts/`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
              body: JSON.stringify(createPayload),
            });
            if (createRes.ok) {
              const createData = await createRes.json().catch(() => ({}));
              contactId = readResolvedContactId(createData);
              if (contactId) contactResolution = 'created_fallback';
            } else {
              const detail = (await createRes.text().catch(() => '')).slice(0, 400);
              console.error('[createAppointment][contact_create_error]', {
                status: createRes.status,
                detail: detail.slice(0, 300),
                hasPhone: !!createPayload.phone,
                hasEmail: !!createPayload.email,
                hasAddress1: !!createPayload.address1,
                hasCity: !!createPayload.city,
              });
              return res.status(502).json({
                error: `Contact force-create mislukt (${createRes.status})`,
                detail,
              });
            }
          }
        }

        if (!contactId) {
          return res.status(502).json({ error: 'Contact resolven mislukt; afspraak kan niet worden aangemaakt' });
        }
        console.log('[createAppointment][contact_resolution]', {
          contact_resolution: contactResolution || 'created_fallback',
          contactId,
          hasPhone: !!phoneNorm,
          hasEmail: !!emailNorm,
        });

        // Stap 2: canoniek adres (address1 + straat/huis-CF) + type/omschrijving
        if (addressNorm) {
          const { address1, customFields: addrCf, parts } = buildCanonicalAddressWritePayload(addressNorm);
          const streetHouseLine = [parts.straatnaam, parts.huisnummer]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          const bookingStraatHuis =
            streetHouseLine ||
            (addressNorm ? String(address1 || addressNorm).replace(/\s+/g, ' ').trim() : '');
          const customFields = [
            ...addrCf,
            { id: FIELD_IDS.type_onderhoud, field_value: apptType || 'reparatie' },
            { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
          ];
          if (plannerNotitiesFieldId && plannerNotitiesNorm) {
            customFields.push({ id: plannerNotitiesFieldId, field_value: plannerNotitiesNorm });
          }
          if (plannerInternalFixedStartFieldId && req.body && Object.prototype.hasOwnProperty.call(req.body, 'internalFixedStart')) {
            customFields.push({
              id: plannerInternalFixedStartFieldId,
              field_value: internalFixedPin ? JSON.stringify(internalFixedPin) : '',
            });
            console.info(
              '[planner] fixed_time_saved',
              JSON.stringify({
                contactId: String(contactId),
                appointmentId: null,
                routeDate: dateNorm,
                fieldId: plannerInternalFixedStartFieldId,
                pinType: internalFixedPin?.type || null,
                pinTime: internalFixedPin?.time || null,
              })
            );
          }
          if (slotLabelNorm) {
            customFields.push({ id: FIELD_IDS.tijdafspraak, field_value: slotLabelNorm });
          }
          if (priceNum !== null) {
            customFields.push({ id: FIELD_IDS.prijs, field_value: String(priceNum) });
            customFields.push({
              id: FIELD_IDS.prijs_regels,
              field_value: JSON.stringify(
                normalizedLines.length
                  ? normalizedLines
                  : [{ desc: desc || 'Handmatige afspraak', price: priceNum }]
              ),
            });
          }
          const structuredPriceRules = formatPriceRulesStructuredString(
            normalizedLines.length
              ? normalizedLines
              : priceNum !== null
                ? [{ desc: desc || 'Handmatige afspraak', price: priceNum }]
                : []
          );
          const bookingCanon = appendBookingCanonFields(
            customFields,
            {
              straat_huisnummer: bookingStraatHuis,
              postcode: parts.postcode || '',
              woonplaats: parts.woonplaats || '',
              type_onderhoud: apptType || 'reparatie',
              probleemomschrijving: desc || '',
              tijdslot: slotLabelNorm || '',
              prijs_totaal: priceNum,
              prijs_regels: structuredPriceRules,
              boeking_bevestigd_datum: dateNorm,
              boeking_bevestigd_dagdeel: slotPart,
              boeking_bevestigd_status: 'confirmed',
            }
          );
          if (addressNorm) {
            if (!String(parts.postcode || '').trim()) {
              bookingCanon.customFields.push({
                id: BOOKING_FORM_FIELD_IDS.postcode,
                value: '',
                field_value: '',
              });
            }
            if (!String(parts.woonplaats || '').trim()) {
              bookingCanon.customFields.push({
                id: BOOKING_FORM_FIELD_IDS.woonplaats,
                value: '',
                field_value: '',
              });
            }
          }
          await appendPlannerInvoicePartyFieldsToCustomFields(bookingCanon.customFields, req.body);
          console.log('[BOOKING_CANON_WRITE]', {
            typeOnderhoud: bookingCanon.written.type_onderhoud || '',
            probleemomschrijving: bookingCanon.written.probleemomschrijving || '',
          });
          const createPutPayload = {
            address1,
            phone: phoneNorm || undefined,
            email: emailNorm || undefined,
            customFields: bookingCanon.customFields,
          };
          mergeGhlNativeAddressFromParts(createPutPayload, parts);
          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify(createPutPayload),
          });
          logCanonicalAddressWrite('createAppointment', { contactId, address1 });
        }

        // Stap 3: interne planner-boeking (Model B1) als Redis-reservering
        const workTypeNorm = normalizeWorkType(apptType || '');

        const reservationOut = await createConfirmedReservation({
          contactId,
          dateStr: dateNorm,
          block: slotPart,
          workType: workTypeNorm,
        });

        if (!reservationOut.ok) {
          if (reservationOut.code === 'DUPLICATE_CONTACT_DATE') {
            return res.status(409).json({
              error: 'Er staat al een afspraak voor dit contact op deze dag.',
              code: 'duplicate_contact_date',
              contactId,
            });
          }
          if (reservationOut.code === 'STORE_UNAVAILABLE') {
            return res.status(503).json({
              error: 'Reserveringsservice tijdelijk niet beschikbaar. Probeer opnieuw.',
              code: 'reservation_store_unavailable',
            });
          }
          return res.status(400).json({
            error: 'Kon planner-reservering niet maken.',
            code: reservationOut.code || 'reservation_create_failed',
          });
        }

        invalidateRedisSyntheticsCacheForDate(dateNorm);
        invalidateAmsterdamDayGhlReadCachesForDate({
          locationId: ghlLocationIdFromEnv(),
          calendarId: effectiveCalendarId(),
          dateStr: dateNorm,
          trigger: 'createAppointment_model_b1',
        });

        console.log('SUPABASE_DEBUG_BEFORE', {
          hasUrl: !!process.env.SUPABASE_URL,
          hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        });

        try {
          console.log('SUPABASE_DEBUG_ATTEMPT');
          const syncResult = await syncAppointmentToSupabase({
            source: 'planner-create',
            externalBookingId: reservationOut.reservation?.id ? String(reservationOut.reservation.id) : null,
            reservationId: reservationOut.reservation?.id ? String(reservationOut.reservation.id) : null,
            ghlContactId: contactId,
            customerName: nameNorm,
            phone: phoneNorm || null,
            email: emailNorm || null,
            address: addressNorm,
            date: dateNorm,
            dayPart: slotPart,
            timeWindow: slotLabelNorm || null,
            status: 'confirmed',
            problemDescription: desc || null,
            priceLines: normalizedLines,
            totalAmount: priceNum,
            rawPayload: {
              bookingModel: 'B',
              syntheticRowId: `hk-b1:${contactId}:${dateNorm}`,
            },
          });
          console.info('[supabase_dual_write_ok]', JSON.stringify({
            source: 'planner-create',
            appointmentId: syncResult?.appointmentId || null,
            customerId: syncResult?.customerId || null,
            priceLineCount: syncResult?.priceLineCount || 0,
            skipped: syncResult?.skipped === true,
          }));
        } catch (err) {
          console.error('[supabase_dual_write_failed]', JSON.stringify({
            source: 'planner-create',
            contactId: contactId || null,
            date: dateNorm || null,
            message: String(err?.message || err),
          }));
          console.log('SUPABASE_DEBUG_ERROR', err?.message || err);
        }

        return res.status(200).json({
          success: true,
          contactId,
          appointmentId: null,
          bookingModel: 'B',
          syntheticRowId: `hk-b1:${contactId}:${dateNorm}`,
          reservationId: reservationOut.reservation?.id || null,
        });
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
        const lockRes = await routeMutationLockResponse(dateNorm, 'deletePlannerBooking');
        if (lockRes) return lockRes;

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

        const ghlApptResult = {
          attempted: false,
          ok: null,
          detail: 'disabled_model_b_single_source_of_truth',
        };

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
        const {
          contactId,
          prevDate,
          newDate,
          newTime,
          newTimeWindow,
          slotKey,
          slotLabel,
          type: rescType,
        } = req.body || {};
        const cid = String(contactId || '').trim();
        const prevDateNorm = normalizeYyyyMmDdInput(String(prevDate || ''));
        const newDateNorm = normalizeYyyyMmDdInput(String(newDate || ''));
        if (!cid || !newDateNorm || !prevDateNorm) {
          return res.status(400).json({ error: 'contactId, prevDate en newDate vereist (YYYY-MM-DD)' });
        }
        const lockResPrev = await routeMutationLockResponse(prevDateNorm, 'rescheduleAppointment');
        if (lockResPrev) return lockResPrev;
        if (newDateNorm !== prevDateNorm) {
          const lockResNew = await routeMutationLockResponse(newDateNorm, 'rescheduleAppointment');
          if (lockResNew) return lockResNew;
        }
        const slotPart =
          slotKey === 'afternoon' || slotKey === 'morning'
            ? slotKey
            : String(newTime || '').startsWith('13:')
              ? 'afternoon'
              : 'morning';
        const workTypeNorm = normalizeWorkType(rescType || '');

        const oldResDelete = await deleteConfirmedReservationForContactDate(cid, prevDateNorm);
        if (!oldResDelete.ok && oldResDelete.code !== 'NO_RESERVATION') {
          return res.status(503).json({
            error: 'Bestaande reservering kon niet worden verwijderd.',
            code: oldResDelete.code || 'reservation_delete_failed',
          });
        }
        const newRes = await createConfirmedReservation({
          contactId: cid,
          dateStr: newDateNorm,
          block: slotPart,
          workType: workTypeNorm,
        });
        if (!newRes.ok) {
          // rollback naar oude datum als nieuwe reservering niet lukt
          if (oldResDelete.ok && oldResDelete.code === 'DELETED') {
            await createConfirmedReservation({
              contactId: cid,
              dateStr: prevDateNorm,
              block: slotPart,
              workType: workTypeNorm,
            }).catch(() => null);
          }
          if (newRes.code === 'DUPLICATE_CONTACT_DATE') {
            return res.status(409).json({
              error: 'Voor deze klant bestaat al een reservering op de nieuwe datum.',
              code: 'duplicate_contact_date',
            });
          }
          if (newRes.code === 'STORE_UNAVAILABLE') {
            return res.status(503).json({
              error: 'Reserveringsservice tijdelijk niet beschikbaar.',
              code: 'reservation_store_unavailable',
            });
          }
          return res.status(400).json({
            error: 'Reservering verplaatsen mislukt.',
            code: newRes.code || 'reservation_reschedule_failed',
          });
        }

        const windowLabel =
          String(newTimeWindow || '').trim() ||
          (slotPart === 'afternoon'
            ? SLOT_LABEL_AFTERNOON_NL
            : slotPart === 'morning'
              ? SLOT_LABEL_MORNING_NL
              : String(slotLabel || '').trim());
        if (cid) {
          const bookingCanon = appendBookingCanonFields(
            [
              { id: FIELD_IDS.tijdafspraak, field_value: windowLabel || '' },
              { id: BOOKING_FORM_FIELD_IDS.tijdslot, field_value: windowLabel || '' },
            ],
            {
              tijdslot: windowLabel || '',
              boeking_bevestigd_datum: newDateNorm,
              boeking_bevestigd_dagdeel: slotPart,
              boeking_bevestigd_status: 'confirmed',
            }
          );
          const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${encodeURIComponent(cid)}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              Version: '2021-04-15',
            },
            body: JSON.stringify({ customFields: bookingCanon.customFields }),
          });
          if (!putRes.ok) {
            const detail = (await putRes.text().catch(() => '')).slice(0, 400);
            return res.status(502).json({ error: 'Contact tijdslot bijwerken mislukt', detail });
          }
        }
        invalidateRedisSyntheticsCacheForDate(prevDateNorm);
        invalidateRedisSyntheticsCacheForDate(newDateNorm);
        const calId = effectiveCalendarId();
        const locId = ghlLocationIdFromEnv();
        if (prevDateNorm) {
          invalidateAmsterdamDayGhlReadCachesForDate({
            locationId: locId,
            calendarId: calId,
            dateStr: prevDateNorm,
            trigger: 'rescheduleAppointment_prevDate',
          });
        }
        if (newDateNorm) {
          invalidateAmsterdamDayGhlReadCachesForDate({
            locationId: locId,
            calendarId: calId,
            dateStr: newDateNorm,
            trigger: 'rescheduleAppointment_newDate',
          });
        }
        console.log('[rescheduleAppointment] bijgewerkt:', {
          contactId: cid,
          prevDate: prevDateNorm,
          newDate: newDateNorm,
          slotPart,
        });
        return res.status(200).json({
          success: true,
          slotLabel: windowLabel || null,
          bookingModel: 'B',
          syntheticRowId: `hk-b1:${cid}:${newDateNorm}`,
        });
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
        const dayPartRaw = String(req.body?.dayPart || 'full').toLowerCase().trim();
        const dayPart = dayPartRaw === 'morning' || dayPartRaw === 'afternoon' ? dayPartRaw : 'full';
        let defaultTitle = 'Dag geblokkeerd';
        let wall = null;
        if (dayPart === 'morning') {
          defaultTitle = 'Ochtend geblokkeerd (09:00–13:00)';
          wall = { startHour: 9, startMinute: 0, endHour: 13, endMinute: 0 };
        } else if (dayPart === 'afternoon') {
          defaultTitle = 'Middag geblokkeerd (13:00–17:00)';
          wall = { startHour: 13, startMinute: 0, endHour: 17, endMinute: 0 };
        }
        const title =
          titleRaw != null && String(titleRaw).trim()
            ? String(titleRaw).trim().slice(0, 120)
            : defaultTitle;
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
            dayPart,
          })
        );
        const r =
          wall != null
            ? await postAmsterdamWallBlockWindow(GHL_BASE, {
                locationId,
                calendarId,
                dateStr: date,
                title,
                apiKey: GHL_API_KEY,
                assignedUserId,
                startHour: wall.startHour,
                startMinute: wall.startMinute,
                endHour: wall.endHour,
                endMinute: wall.endMinute,
              })
            : await postFullDayBlockSlot(GHL_BASE, {
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
