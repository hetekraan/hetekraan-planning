import { fetchWithRetry } from './retry.js';

const fieldIdCache = new Map();
const fieldNotFoundCache = new Set();
const loggedResolved = new Set();
const loggedFailed = new Set();

function cacheKey(locationId, objectType, fieldKey) {
  return `${String(locationId || '').trim()}::${String(objectType || 'contact').trim()}::${String(fieldKey || '').trim()}`;
}

/**
 * Resolve contact custom-field id by key via GHL API.
 * Caches positive and negative lookups in-memory for the process lifetime.
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
  if (override) {
    const ck = cacheKey(loc, obj, key);
    fieldIdCache.set(ck, override);
    if (!loggedResolved.has(ck)) {
      loggedResolved.add(ck);
      console.log(`[GHL_FIELD_RESOLVE] ${key} -> ${override}`);
    }
    return override;
  }

  const ck = cacheKey(loc, obj, key);
  if (fieldIdCache.has(ck)) return fieldIdCache.get(ck);
  if (fieldNotFoundCache.has(ck)) return null;

  const url = `${String(baseUrl).replace(/\/+$/, '')}/custom-fields?locationId=${encodeURIComponent(loc)}`;
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
  const data = await res.json().catch(() => ({}));
  const rows = Array.isArray(data?.customFields)
    ? data.customFields
    : Array.isArray(data?.fields)
      ? data.fields
      : [];

  const hit = rows.find((row) => {
    const rowObject =
      String(row?.object || row?.model || row?.resource || '').trim().toLowerCase();
    const rowKey = String(row?.key || row?.fieldKey || '').trim();
    const objectMatches = !rowObject || rowObject === obj;
    return objectMatches && rowKey === key;
  });
  const id = String(hit?.id || hit?.fieldId || '').trim();
  if (res.ok && id) {
    fieldIdCache.set(ck, id);
    if (!loggedResolved.has(ck)) {
      loggedResolved.add(ck);
      console.log(`[GHL_FIELD_RESOLVE] ${key} -> ${id}`);
    }
    return id;
  }

  fieldNotFoundCache.add(ck);
  if (!loggedFailed.has(ck)) {
    loggedFailed.add(ck);
    console.error(`[GHL_FIELD_RESOLVE_FAIL] ${key}`, {
      httpStatus: res.status,
      rows: rows.length,
    });
  }
  return null;
}
