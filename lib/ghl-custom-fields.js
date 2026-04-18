import { fetchWithRetry } from './retry.js';

const fieldIdCache = new Map();
const fieldNotFoundCache = new Set();
const loggedResolved = new Set();
const loggedFailed = new Set();
const loggedDefinition = new Set();
const loggedCustomFieldMatch = new Set();
/** locationId — één dump per proces om logspam te beperken */
const loggedCustomFieldsDumpLocations = new Set();

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

/** Vergelijkbaar maken: lowercase, spaties/streepjes/punten → underscore, dubbele underscores samenvoegen. */
export function normalizeComparableFieldKey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Rijen die als contact-custom-field bedoeld zijn (GHL soms zonder object/model). */
export function rowIsContactLikeCustomField(row) {
  const o = normalizeObjectType(row);
  if (o === 'contact' || o === 'contacts') return true;
  if (!o) return true;
  if (o.includes('opportunity') || o === 'opportunities' || o === 'company' || o === 'business') return false;
  return false;
}

export function summarizeContactCustomFieldRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? row.fieldId ?? row.customFieldId ?? null,
    name: row.name ?? null,
    key: row.key ?? row.fieldKey ?? null,
    fieldKey: row.fieldKey ?? row.key ?? null,
    placeholder: row.placeholder ?? row.placeHolder ?? row.placeholderValue ?? null,
    object: row.object ?? row.model ?? row.resource ?? null,
    dataType: row.dataType ?? row.type ?? row.fieldType ?? null,
    locationId: row.locationId ?? null,
    position: row.position ?? row.index ?? null,
  };
}

/** Uitgebreide logregel voor diagnostics (id, name, keys, placeholder, types). */
export function summarizeCustomFieldRowForDiagnostics(row) {
  const s = summarizeContactCustomFieldRow(row);
  if (!s) return null;
  return {
    ...s,
    slug: row.slug ?? null,
    standardFieldKey: row.standardFieldKey ?? null,
    type: row.type ?? null,
    fieldType: row.fieldType ?? null,
    model: row.model ?? null,
    resource: row.resource ?? null,
  };
}

function collectRowSearchEntries(row) {
  const entries = [];
  const add = (raw, source) => {
    const t = String(raw ?? '').trim();
    if (!t) return;
    entries.push({ raw: t, source, normalized: normalizeComparableFieldKey(t) });
  };
  add(row?.key, 'key');
  add(row?.fieldKey, 'fieldKey');
  add(row?.slug, 'slug');
  add(row?.standardFieldKey, 'standardFieldKey');
  add(row?.name, 'name');
  add(row?.placeholder ?? row?.placeHolder ?? row?.placeholderValue, 'placeholder');
  return entries;
}

function rowSearchBlobNormalized(row) {
  return normalizeComparableFieldKey(
    [row?.key, row?.fieldKey, row?.slug, row?.standardFieldKey, row?.name, row?.placeholder, row?.placeHolder]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * Eerst exacte key (bestaand gedrag), daarna genormaliseerde match op key/fieldKey/name/placeholder,
 * daarna beperkte keyword-match voor moneybird_invoice_token.
 *
 * @returns {null | { row: object, matchedBy: string }}
 */
export function findContactCustomFieldRowFlexible(rows, fieldKey, objectType = 'contact') {
  const wantKey = String(fieldKey || '').trim();
  const wantNorm = normalizeComparableFieldKey(wantKey);
  if (!wantKey || !Array.isArray(rows)) return null;

  const exact = findContactCustomFieldRowByKey(rows, wantKey, objectType);
  if (exact) return { row: exact, matchedBy: 'fieldKey_exact' };

  const pool = rows.filter((r) => rowIsContactLikeCustomField(r));
  const normMatches = [];
  for (const row of pool) {
    for (const { source, normalized } of collectRowSearchEntries(row)) {
      if (normalized && normalized === wantNorm) {
        normMatches.push({ row, matchedBy: `normalized:${source}` });
        break;
      }
    }
  }
  const dedupe = new Map();
  for (const m of normMatches) {
    const id = String(m.row?.id ?? m.row?.fieldId ?? m.row?.customFieldId ?? '').trim();
    if (id && !dedupe.has(id)) dedupe.set(id, m);
  }
  const uniq = [...dedupe.values()];
  if (uniq.length === 1) return uniq[0];
  if (uniq.length > 1) {
    console.warn(
      '[moneybird] ghl_custom_field_match_ambiguity',
      JSON.stringify({
        requestedKey: wantKey,
        phase: 'normalized_key',
        count: uniq.length,
        candidates: uniq.map(({ row, matchedBy }) => {
          const s = summarizeCustomFieldRowForDiagnostics(row);
          return { matchedBy, ...s };
        }),
      })
    );
    const prefer = uniq.find(({ row }) => {
      const b = rowSearchBlobNormalized(row);
      return b.includes('moneybird') && b.includes('invoice') && b.includes('token');
    });
    return prefer || uniq[0];
  }

  if (wantNorm.includes('moneybird') && wantNorm.includes('token')) {
    const kw = [];
    for (const row of pool) {
      const b = rowSearchBlobNormalized(row);
      if (!b) continue;
      if (b.includes('moneybird') && (b.includes('token') || b.includes('invoice') || b.includes('pay'))) {
        kw.push({ row, matchedBy: 'keyword:moneybird+(token|invoice|pay)' });
      }
    }
    const kwDedupe = new Map();
    for (const m of kw) {
      const id = String(m.row?.id ?? m.row?.fieldId ?? m.row?.customFieldId ?? '').trim();
      if (id && !kwDedupe.has(id)) kwDedupe.set(id, m);
    }
    const ku = [...kwDedupe.values()];
    if (ku.length === 1) return ku[0];
    if (ku.length > 1) {
      console.warn(
        '[moneybird] ghl_custom_field_match_ambiguity',
        JSON.stringify({
          requestedKey: wantKey,
          phase: 'keyword_moneybird',
          count: ku.length,
          candidates: ku.map(({ row, matchedBy }) => {
            const s = summarizeCustomFieldRowForDiagnostics(row);
            return { matchedBy, ...s };
          }),
        })
      );
      const prefer = ku.find(({ row }) => {
        const b = rowSearchBlobNormalized(row);
        return b.includes('invoice') && b.includes('token');
      });
      return prefer || ku[0];
    }
  }

  return null;
}

function maybeLogGhlCustomFieldsDump(locationId, rows, requestedKey) {
  const loc = String(locationId || '').trim();
  if (!loc || !Array.isArray(rows) || rows.length === 0) return;
  const rk = String(requestedKey || '').toLowerCase();
  if (!rk.includes('moneybird') && rk !== 'moneybird_invoice_token') return;
  if (loggedCustomFieldsDumpLocations.has(loc)) return;
  loggedCustomFieldsDumpLocations.add(loc);

  const contactLike = rows.filter((r) => rowIsContactLikeCustomField(r));
  const kwRe = /moneybird|invoice|token|pay|factuur/i;
  const keywordHits = contactLike.filter((row) => {
    const blob = [
      row?.key,
      row?.fieldKey,
      row?.slug,
      row?.standardFieldKey,
      row?.name,
      row?.placeholder,
      row?.placeHolder,
    ].join(' ');
    return kwRe.test(String(blob || ''));
  });

  console.info(
    '[moneybird] ghl_custom_fields_dump',
    JSON.stringify({
      locationId: loc,
      requestedKey,
      totalRows: rows.length,
      contactLikeCount: contactLike.length,
      keywordHitCount: keywordHits.length,
      keywordHits: keywordHits.map((row) => summarizeCustomFieldRowForDiagnostics(row)),
      allContactLikeFields: contactLike.map((row) => summarizeCustomFieldRowForDiagnostics(row)),
    })
  );
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
  const flex = findContactCustomFieldRowFlexible(rows, fieldKey, objectType);
  return flex?.row ?? null;
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
  maybeLogGhlCustomFieldsDump(loc, rows, key);

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

  const flex = findContactCustomFieldRowFlexible(rows, key, obj);
  const hit = flex?.row ?? null;
  const matchedBy = flex?.matchedBy ?? null;
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

  if (hit && apiId && !loggedCustomFieldMatch.has(defKey)) {
    loggedCustomFieldMatch.add(defKey);
    const sumD = summarizeCustomFieldRowForDiagnostics(hit);
    console.info(
      '[moneybird] ghl_custom_field_match',
      JSON.stringify({
        requestedKey: key,
        matchedBy: matchedBy || 'fieldKey_exact',
        matchedId: apiId,
        matchedName: sumD?.name ?? null,
        matchedFieldKey: rowFieldKey(hit) || sumD?.fieldKey || sumD?.key || null,
        locationId: loc,
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
