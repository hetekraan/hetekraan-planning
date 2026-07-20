/**
 * Notion-sync wrapper (naast lib/moneybird.js).
 *
 * Notion is de single source of truth voor prestatie-analyse (marge per klant,
 * per bron, per type werk). Deze module maakt/bijwerkt een Klant + Klus in Notion
 * bij klus-completion. Alle fouten zijn NIET-fataal voor de "Klaar"-flow; de
 * aanroeper vangt ze af en toont een status-pill met retry.
 *
 * Officiele Notion API:
 *   - POST   https://api.notion.com/v1/pages
 *   - PATCH  https://api.notion.com/v1/pages/{page_id}
 *   - POST   https://api.notion.com/v1/databases/{database_id}/query
 * Headers: Authorization: Bearer {NOTION_TOKEN}, Notion-Version: 2022-06-28,
 *          Content-Type: application/json
 */

import { normalizeWorkType } from './booking-blocks.js';
import { normalizeNlPhone } from './ghl-phone.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** Property-namen exact zoals in de Notion-databases (case-sensitive). */
export const NOTION_KLANT_PROPS = {
  naam: 'Naam',
  adres: 'Adres',
  telefoon: 'Telefoon',
  email: 'Email',
  quookerModel: 'Quooker-model',
  bron: 'Bron',
  ghlId: 'GHL-ID',
};

export const NOTION_KLUS_PROPS = {
  titel: 'Titel',
  klant: 'Klant',
  datum: 'Datum',
  typeWerk: 'Type werk',
  omzet: 'Omzet',
  materiaalkosten: 'Materiaalkosten',
  status: 'Status',
  plannerLink: 'Planner-link',
  // Per-appointment idempotentie: stabiele referentie (appointmentId) om dubbele klussen te voorkomen.
  ref: 'Ref',
};

/**
 * Planner-notitiemarker (analoog aan de Moneybird-marker). Draagt de Notion-status
 * zodat de planner-pill die na een reload kan tonen zonder de appointment-mapper te wijzigen.
 * Formaat: `[notion] status=<pending|synced|error> klusId=<id> url=<https...>`
 */
export function appendNotionPlannerNote(existingNotes, { appointmentId, status, klusId, url } = {}) {
  const apptId = String(appointmentId || '').trim();
  const lines = String(existingNotes || '').split(/\r?\n/);
  // Behoud alle niet-notion-regels (incl. [moneybird]) én de [notion]-markers van ANDERE afspraken.
  const kept = lines.filter((line) => {
    if (!/^\s*\[notion\]/i.test(line)) return true;
    if (!apptId) return false; // geen appointmentId → legacy: vervang alle notion-markers
    const lineAppt = line.match(/\bappointmentId=([^\s]+)/i)?.[1] || '';
    return lineAppt !== apptId;
  });
  const base = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const parts = [];
  if (apptId) parts.push(`appointmentId=${apptId}`);
  const kid = String(klusId || '').trim();
  if (kid) parts.push(`klusId=${kid}`);
  parts.push(`status=${String(status || 'pending').trim()}`);
  const u = String(url || '').trim();
  if (u) parts.push(`url=${u}`);
  const marker = `[notion] ${parts.join(' ')}`;
  return base ? `${base}\n${marker}` : marker;
}

/**
 * Parse de `[notion]`-marker uit notitietekst. Met appointmentId: zoekt de marker
 * van díe afspraak (meerdere markers per contact mogelijk). Return null als afwezig.
 */
export function parseNotionPlannerNote(notes, appointmentId) {
  const raw = String(notes || '');
  const apptId = String(appointmentId || '').trim();
  const markers = raw.match(/\[notion\][^\n\r]*/gi) || [];
  if (!markers.length) return null;
  const line = apptId
    ? markers.find((mk) => (mk.match(/\bappointmentId=([^\s]+)/i)?.[1] || '') === apptId) || null
    : markers[0];
  if (!line) return null;
  const status = (line.match(/\bstatus=([a-z]+)/i)?.[1] || '').toLowerCase() || null;
  const klusId = line.match(/\bklusId=([^\s]+)/i)?.[1] || '';
  const url = line.match(/\burl=(https?:\/\/[^\s]+)/i)?.[1] || '';
  const apptOut = line.match(/\bappointmentId=([^\s]+)/i)?.[1] || '';
  return { appointmentId: apptOut, status, klusId, url };
}

/**
 * Defensieve sanitize voor env-vars die als database-ID of token worden gebruikt.
 * Vercel-env raakt soms vervuild (bijv. de waarde 4x geplakt met newlines ertussen);
 * we nemen het eerste token na trim zodat whitespace/newlines nooit naar Notion gaan.
 */
export function sanitizeNotionEnvId(v) {
  return String(v ?? '').trim().split(/[\s\n\r]+/)[0] || '';
}

/** Leest + saneert alle Notion-env-vars en logt raw/sanitized lengtes (om vervuiling te zien). */
export function readSanitizedNotionEnv() {
  const rawToken = String(process.env.NOTION_TOKEN ?? '');
  const rawKlanten = String(process.env.NOTION_DB_KLANTEN ?? '');
  const rawKlussen = String(process.env.NOTION_DB_KLUSSEN ?? '');
  const token = sanitizeNotionEnvId(rawToken);
  const klantenDb = sanitizeNotionEnvId(rawKlanten);
  const klussenDb = sanitizeNotionEnvId(rawKlussen);
  console.info(
    '[notion] sanitized_env_vars',
    JSON.stringify({
      raw_klanten_len: rawKlanten.length,
      sanitized_klanten_len: klantenDb.length,
      raw_klussen_len: rawKlussen.length,
      sanitized_klussen_len: klussenDb.length,
      raw_token_len: rawToken.length,
      sanitized_token_len: token.length,
      klanten_dirty: rawKlanten.length !== klantenDb.length,
      klussen_dirty: rawKlussen.length !== klussenDb.length,
      token_dirty: rawToken.length !== token.length,
    })
  );
  return { token, klantenDb, klussenDb };
}

export function isNotionConfigured() {
  return Boolean(
    sanitizeNotionEnvId(process.env.NOTION_TOKEN) &&
      sanitizeNotionEnvId(process.env.NOTION_DB_KLANTEN) &&
      sanitizeNotionEnvId(process.env.NOTION_DB_KLUSSEN)
  );
}

function notionText(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || s.toLowerCase() === 'null') return '';
  return s;
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map ruwe GHL-bron naar een van de vaste Notion select-waardes.
 * Default "Onbekend" (nooit blokkerend).
 */
export function mapBronToNotion(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'Onbekend';
  if (s.includes('facebook') || s.includes('fb') || s.includes('meta')) return 'Facebook';
  if (s.includes('google') || s.includes('adwords')) return 'Google';
  if (s.includes('website') || s.includes('web')) return 'Website';
  if (s.includes('referral') || s.includes('doorverwezen')) return 'Doorverwezen';
  return 'Onbekend';
}

/** Map werktype naar de vaste Notion select-waardes (Titel-Case). */
export function mapTypeWerkToNotion(raw) {
  const s = normalizeWorkType(raw);
  const map = {
    installatie: 'Installatie',
    reparatie: 'Reparatie',
    onderhoud: 'Onderhoud',
    herafspraak: 'Herafspraak',
  };
  return map[s] || 'Reparatie';
}

/** Telefoon E.164-genormaliseerd (zelfde normalisatie als GHL-duplicate-search). */
export function normalizeNotionPhone(raw) {
  return normalizeNlPhone(raw) || '';
}

function titleProp(value) {
  return { title: [{ text: { content: notionText(value).slice(0, 2000) } }] };
}

function richTextProp(value) {
  const s = notionText(value);
  return { rich_text: s ? [{ text: { content: s.slice(0, 2000) } }] : [] };
}

function selectProp(value) {
  const s = notionText(value);
  return { select: s ? { name: s } : null };
}

function numberProp(value) {
  const n = toFiniteNumber(value);
  return { number: n };
}

function readNotionRequestConfig(deps) {
  const token = sanitizeNotionEnvId(process.env.NOTION_TOKEN);
  const fetchImpl =
    (deps && typeof deps.fetch === 'function' && deps.fetch) ||
    (typeof fetch === 'function' ? fetch : null);
  if (!token) {
    const err = new Error('NOTION_TOKEN ontbreekt');
    err.code = 'notion_not_configured';
    throw err;
  }
  if (!fetchImpl) {
    const err = new Error('fetch niet beschikbaar');
    err.code = 'notion_no_fetch';
    throw err;
  }
  return { token, fetchImpl };
}

/** Eén Notion API-call. Gooit een Error met .status/.code bij een niet-2xx antwoord. */
export async function notionRequest(path, { method = 'GET', body, deps } = {}) {
  const { token, fetchImpl } = readNotionRequestConfig(deps);
  const res = await fetchImpl(`${NOTION_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(notionText(data?.message) || `Notion API ${res.status}`);
    err.status = res.status;
    err.code = data?.code || `http_${res.status}`;
    err.notion = data;
    throw err;
  }
  return data;
}

async function queryKlantByProperty(dbId, filter, deps) {
  const data = await notionRequest(`/databases/${encodeURIComponent(dbId)}/query`, {
    method: 'POST',
    body: { filter, page_size: 1 },
    deps,
  });
  const results = Array.isArray(data?.results) ? data.results : [];
  return results[0]?.id || null;
}

/**
 * Zoek een bestaande klant-page id.
 * Volgorde (snelste eerst): GHL-opgeslagen notion_klant_id → GHL-ID property → Telefoon.
 */
async function findKlantPageId({ ghlId, phone, notionKlantIdHint }, dbId, deps) {
  const hint = notionText(notionKlantIdHint);
  if (hint) {
    // Verifieer dat de page nog bestaat/niet gearchiveerd is.
    try {
      const page = await notionRequest(`/pages/${encodeURIComponent(hint)}`, { deps });
      if (page?.id && page?.archived !== true) return page.id;
    } catch (err) {
      if (err?.status !== 404) throw err;
    }
  }
  const gid = notionText(ghlId);
  if (gid) {
    const byGhl = await queryKlantByProperty(
      dbId,
      { property: NOTION_KLANT_PROPS.ghlId, rich_text: { equals: gid } },
      deps
    );
    if (byGhl) return byGhl;
  }
  const tel = normalizeNotionPhone(phone);
  if (tel) {
    const byPhone = await queryKlantByProperty(
      dbId,
      { property: NOTION_KLANT_PROPS.telefoon, phone_number: { equals: tel } },
      deps
    );
    if (byPhone) return byPhone;
  }
  return null;
}

function buildKlantProperties(klantData) {
  const props = {
    [NOTION_KLANT_PROPS.naam]: titleProp(klantData?.naam || 'Klant'),
    [NOTION_KLANT_PROPS.adres]: richTextProp(klantData?.adres),
    [NOTION_KLANT_PROPS.email]: { email: notionText(klantData?.email) || null },
    [NOTION_KLANT_PROPS.ghlId]: richTextProp(klantData?.ghlId),
    [NOTION_KLANT_PROPS.bron]: selectProp(mapBronToNotion(klantData?.bron)),
  };
  const tel = normalizeNotionPhone(klantData?.telefoon);
  if (tel) props[NOTION_KLANT_PROPS.telefoon] = { phone_number: tel };
  // Quooker-model alleen zetten als er een bronwaarde is (anders select ongemoeid laten).
  const model = notionText(klantData?.quookerModel);
  if (model) props[NOTION_KLANT_PROPS.quookerModel] = selectProp(model);
  return props;
}

/**
 * Maak of werk een klant bij in de Notion Klanten-db.
 * @returns {Promise<{ pageId: string, created: boolean }>}
 */
export async function upsertKlantInNotion(klantData = {}, deps) {
  const { klantenDb: dbId } = readSanitizedNotionEnv();
  if (!dbId) {
    const err = new Error('NOTION_DB_KLANTEN ontbreekt');
    err.code = 'notion_not_configured';
    throw err;
  }
  const existingPageId = await findKlantPageId(
    {
      ghlId: klantData?.ghlId,
      phone: klantData?.telefoon,
      notionKlantIdHint: klantData?.notionKlantId,
    },
    dbId,
    deps
  );
  const properties = buildKlantProperties(klantData);
  if (existingPageId) {
    const updated = await notionRequest(`/pages/${encodeURIComponent(existingPageId)}`, {
      method: 'PATCH',
      body: { properties },
      deps,
    });
    return { pageId: updated?.id || existingPageId, created: false };
  }
  const created = await notionRequest('/pages', {
    method: 'POST',
    body: { parent: { database_id: dbId }, properties },
    deps,
  });
  if (!created?.id) {
    const err = new Error('Notion klant-page zonder id');
    err.code = 'notion_no_page_id';
    throw err;
  }
  return { pageId: created.id, created: true };
}

function buildKlusProperties(klusData, notionKlantPageId) {
  const props = {
    [NOTION_KLUS_PROPS.titel]: titleProp(klusData?.titel || 'Klus'),
    [NOTION_KLUS_PROPS.klant]: { relation: [{ id: String(notionKlantPageId) }] },
    [NOTION_KLUS_PROPS.typeWerk]: selectProp(mapTypeWerkToNotion(klusData?.typeWerk)),
    [NOTION_KLUS_PROPS.omzet]: numberProp(klusData?.omzet),
    [NOTION_KLUS_PROPS.materiaalkosten]: numberProp(klusData?.materiaalkosten),
    [NOTION_KLUS_PROPS.status]: selectProp(klusData?.status || 'Afgerond'),
  };
  const datum = notionText(klusData?.datum);
  if (datum) props[NOTION_KLUS_PROPS.datum] = { date: { start: datum } };
  const link = notionText(klusData?.plannerLink);
  if (link) props[NOTION_KLUS_PROPS.plannerLink] = { url: link };
  const ref = notionText(klusData?.ref);
  if (ref) props[NOTION_KLUS_PROPS.ref] = richTextProp(ref);
  // Marge is een Notion-formule → NIET door code schrijven.
  return props;
}

/**
 * Zoek een bestaande klus-page op de stabiele per-appointment referentie (property "Ref").
 * Gebruikt voor idempotentie: elke afspraak = eigen klus, retry maakt geen duplicaat.
 * @returns {Promise<{ pageId: string, url: string }|null>}
 */
export async function findKlusByRef(ref, deps) {
  const dbId = sanitizeNotionEnvId(process.env.NOTION_DB_KLUSSEN);
  if (!dbId) {
    const err = new Error('NOTION_DB_KLUSSEN ontbreekt');
    err.code = 'notion_not_configured';
    throw err;
  }
  const r = notionText(ref);
  if (!r) return null;
  const data = await notionRequest(`/databases/${encodeURIComponent(dbId)}/query`, {
    method: 'POST',
    body: { filter: { property: NOTION_KLUS_PROPS.ref, rich_text: { equals: r } }, page_size: 1 },
    deps,
  });
  const results = Array.isArray(data?.results) ? data.results : [];
  const page = results[0];
  return page?.id ? { pageId: page.id, url: notionText(page.url) } : null;
}

/**
 * Maak een nieuwe klus aan in de Notion Klussen-db, gerelateerd aan de klant.
 * @returns {Promise<{ pageId: string, url: string }>}
 */
export async function createKlusInNotion(klusData = {}, notionKlantPageId, deps) {
  const dbId = sanitizeNotionEnvId(process.env.NOTION_DB_KLUSSEN);
  if (!dbId) {
    const err = new Error('NOTION_DB_KLUSSEN ontbreekt');
    err.code = 'notion_not_configured';
    throw err;
  }
  if (!notionText(notionKlantPageId)) {
    const err = new Error('notionKlantPageId ontbreekt voor klus');
    err.code = 'notion_missing_klant';
    throw err;
  }
  const created = await notionRequest('/pages', {
    method: 'POST',
    body: {
      parent: { database_id: dbId },
      properties: buildKlusProperties(klusData, notionKlantPageId),
    },
    deps,
  });
  if (!created?.id) {
    const err = new Error('Notion klus-page zonder id');
    err.code = 'notion_no_page_id';
    throw err;
  }
  return { pageId: created.id, url: notionText(created?.url) };
}
