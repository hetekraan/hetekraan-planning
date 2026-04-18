import { fetchWithRetry } from './retry.js';

const fieldIdCache = new Map();
const fieldNotFoundCache = new Set();
const loggedResolved = new Set();
const loggedFailed = new Set();
const loggedDefinition = new Set();

/** @type {Map<string, { rows: unknown[], ts: number }>} */
const customFieldListCacheByLocation = new Map();
const CUSTOM_FIELD_LIST_TTL_MS = 5 * 60 * 1000;

function cacheKey(locationId, objectType, fieldKey) {
  return `${String(locationId || '').trim()}::${String(objectType || 'contact').trim()}::${String(fieldKey || '').trim()}`;
}

function normalizeObjectType(row) {
  return String(row?.object || row?.model || row?.resource || '')
    .trim()
    .toLowerCase();
}

function rowFieldKey(row) {
  return String(row?.key || row?.fieldKey || '').trim();
}

export function summarizeContactCustomFieldRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? row.fieldId ?? row.customFieldId ?? null,
    name: row.name ?? null,
    key: row.key ?? row.fieldKey ?? null,
    fieldKey: row.fieldKey ?? row.key ?? null,
    object: row.object ?? row.model ?? row.resource ?? null,
    dataType: row.dataType ?? row.type ?? row.fieldType ?? null,
    locationId: row.locationId ?? null,
    position: row.position ?? row.index ?? null,
  };
}

/**
 * Haalt alle custom field definities voor een location (cached).
 * @returns {Promise<{ ok: boolean, rows: unknown[], httpStatus: number }>}
 */
export async function fetchContactCustomFieldDefinitions({ baseUrl, apiKey, locationId } = {}) {
  const loc = String(locationId || '').trim();
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!loc || !root || !apiKey) return { ok: false, rows: [], httpStatus: 0 };

  const cached = customFieldListCacheByLocation.get(loc);
  if (cached && Date.now() - cached.ts < CUSTOM_FIELD_LIST_TTL_MS) {
    return { ok: true, rows: cached.rows, httpStatus: 200 };
  }

  const tryUrls = [
    `${root}/custom-fields?locationId=${encodeURIComponent(loc)}`,
    `${root}/locations/${encodeURIComponent(loc)}/customFields`,
  ];
  let lastStatus = 0;
  let rows = [];
  for (const url of tryUrls) {
    const res = await fetchWithRetry(
      url,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
      },
      0
    );
    lastStatus = res.status;
    const data = await res.json().catch(() => ({}));
    rows = Array.isArray(data?.customFields)
      ? data.customFields
      : Array.isArray(data?.fields)
        ? data.fields
        : Array.isArray(data?.data)
          ? data.data
          : [];
    if (res.ok && rows.length > 0) {
      customFieldListCacheByLocation.set(loc, { rows, ts: Date.now() });
      return { ok: true, rows, httpStatus: res.status };
    }
  }
  customFieldListCacheByLocation.set(loc, { rows, ts: Date.now() });
  return { ok: lastStatus >= 200 && lastStatus < 300, rows, httpStatus: lastStatus };
}

/**
 * Zoek een CONTACT-veld op exacte fieldKey (geen losse env-id zonder verificatie).
 */
export function findContactCustomFieldRowByKey(rows, fieldKey, objectType = 'contact') {
  const wantKey = String(fieldKey || '').trim();
  const wantObj = String(objectType || 'contact').trim().toLowerCase();
  if (!wantKey || !Array.isArray(rows)) return null;

  const candidates = rows.filter((row) => rowFieldKey(row) === wantKey);
  if (candidates.length === 0) return null;

  const strictContact = candidates.filter((row) => {
    const o = normalizeObjectType(row);
    return o === 'contact' || o === 'contacts';
  });
  const pool = strictContact.length ? strictContact : candidates;

  const preferWritable = pool.filter((row) => {
    const ro = summarizeContactCustomFieldRow(row);
    const dt = String(ro?.dataType || '').toLowerCase();
    if (!dt) return true;
    return !['folder', 'fieldset', 'divider', 'label'].includes(dt);
  });
  return (preferWritable.length ? preferWritable : pool)[0] || null;
}

/** @returns {Promise<ReturnType<typeof summarizeContactCustomFieldRow> | null>} */
export async function getContactCustomFieldRowForKey(opts) {
  const { baseUrl, apiKey, locationId, fieldKey, objectType } = opts || {};
  const { ok, rows } = await fetchContactCustomFieldDefinitions({ baseUrl, apiKey, locationId });
  if (!ok) return null;
  return findContactCustomFieldRowByKey(rows, fieldKey, objectType);
}

/**
 * Resolve contact custom-field id by key via GHL API.
 * Caches positive and negative lookups in-memory for the process lifetime.
 *
 * Belangrijk: `envOverride` wordt ALLEEN gebruikt als hij exact overeenkomt met het id
 * uit de GHL custom-fields lijst voor deze key. Anders loggen we een mismatch en gebruiken
 * we het API-id (voorkomt bv. "120" dat een UI-index of verkeerde id is).
 */
export async function resolveContactCustomFieldId({
  baseUrl,
  apiKey,
  locationId,
  fieldKey,
  objectType = 'contact',
  envOverride,
} = {}) {
  const key = String(fieldKey || '').trim();
  const loc = String(locationId || '').trim();
  const obj = String(objectType || 'contact').trim();
  if (!key || !loc || !baseUrl || !apiKey) return null;

  const override = String(envOverride || '').trim();
  const ck = cacheKey(loc, obj, key);

  if (fieldIdCache.has(ck)) return fieldIdCache.get(ck);
  if (fieldNotFoundCache.has(ck)) return null;

  const { ok, rows, httpStatus } = await fetchContactCustomFieldDefinitions({ baseUrl, apiKey, locationId });
  if (!ok) {
    if (!loggedFailed.has(`${ck}:fetch`)) {
      loggedFailed.add(`${ck}:fetch`);
      console.error(`[GHL_FIELD_RESOLVE_FAIL] ${key}`, { httpStatus, reason: 'custom_fields_list_fetch_failed' });
    }
    if (override) {
      console.warn(`[GHL_FIELD_RESOLVE_UNVERIFIED_OVERRIDE] ${key} -> ${override}`, {
        reason: 'api_list_unavailable_using_env_anyway',
      });
      fieldIdCache.set(ck, override);
      return override;
    }
    return null;
  }

  const hit = findContactCustomFieldRowByKey(rows, key, obj);
  const apiId = hit ? String(hit?.id ?? hit?.fieldId ?? hit?.customFieldId ?? '').trim() : '';

  const defKey = `${loc}::${key}`;
  if (hit && !loggedDefinition.has(defKey)) {
    loggedDefinition.add(defKey);
    const sum = summarizeContactCustomFieldRow(hit);
    console.info(
      `[moneybird] ghl_custom_field_definition`,
      JSON.stringify({
        fieldKey: key,
        locationId: loc,
        ...sum,
        rowKeys: hit && typeof hit === 'object' ? Object.keys(hit).slice(0, 40) : [],
      })
    );
  }

  if (hit && apiId) {
    if (override && override !== apiId) {
      console.warn(
        `[GHL_FIELD_RESOLVE_OVERRIDE_MISMATCH] ${key}`,
        JSON.stringify({
          envOverride: override,
          apiId,
          name: hit?.name,
          object: summarizeContactCustomFieldRow(hit)?.object,
          hint: 'Env id wijkt af van GHL custom-fields API; we gebruiken apiId.',
        })
      );
      fieldIdCache.set(ck, apiId);
      if (!loggedResolved.has(ck)) {
        loggedResolved.add(ck);
        console.log(`[GHL_FIELD_RESOLVE] ${key} -> ${apiId} (api, override rejected)`);
      }
      return apiId;
    }
    fieldIdCache.set(ck, apiId);
    if (!loggedResolved.has(ck)) {
      loggedResolved.add(ck);
      console.log(`[GHL_FIELD_RESOLVE] ${key} -> ${apiId}`);
    }
    return apiId;
  }

  if (override) {
    console.warn(
      `[GHL_FIELD_RESOLVE_NO_API_MATCH] ${key}`,
      JSON.stringify({
        envOverride: override,
        hint: 'Geen rij met deze fieldKey in custom-fields lijst; override kan ongeldig zijn.',
      })
    );
    fieldIdCache.set(ck, override);
    if (!loggedResolved.has(ck)) {
      loggedResolved.add(ck);
      console.log(`[GHL_FIELD_RESOLVE] ${key} -> ${override} (unverified env)`);
    }
    return override;
  }

  if (fieldNotFoundCache.has(ck)) return null;
  fieldNotFoundCache.add(ck);
  if (!loggedFailed.has(ck)) {
    loggedFailed.add(ck);
    console.error(`[GHL_FIELD_RESOLVE_FAIL] ${key}`, {
      httpStatus,
      rows: rows.length,
      reason: 'no_matching_field_key',
    });
  }
  return null;
}
