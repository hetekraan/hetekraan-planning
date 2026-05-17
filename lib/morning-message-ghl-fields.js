/**
 * GHL custom field ids voor ochtendmeldingen (dynamisch via API-lijst).
 */

import {
  fetchContactCustomFieldDefinitions,
  resolveContactCustomFieldId,
} from './ghl-custom-fields.js';
import { ghlLocationIdFromEnv } from './ghl-env-ids.js';

const VENSTER_FIELD_KEY = 'geplande_aankomst_venster';

/** @param {unknown[]} rows */
export function listContactCustomFieldKeysFromRows(rows) {
  if (!Array.isArray(rows)) return [];
  const keys = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const raw of [row.key, row.fieldKey, row.slug, row.standardFieldKey, row.name]) {
      const t = String(raw || '').trim();
      if (t) keys.add(t);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * Keys uit GHL custom-fields lijst (voor diagnose bij mislukte venster-resolve).
 * @param {{ baseUrl: string, apiKey: string, locationId?: string }} opts
 */
export async function listContactCustomFieldKeysForLookup(opts) {
  const baseUrl = String(opts?.baseUrl || '').trim();
  const apiKey = String(opts?.apiKey || '').trim();
  const locationId = String(opts?.locationId || ghlLocationIdFromEnv() || '').trim();
  if (!baseUrl || !apiKey || !locationId) return [];
  const { ok, rows } = await fetchContactCustomFieldDefinitions({ baseUrl, apiKey, locationId });
  return ok ? listContactCustomFieldKeysFromRows(rows) : [];
}

export { VENSTER_FIELD_KEY };

/**
 * @param {{ baseUrl: string, apiKey: string, locationId?: string }} opts
 * @returns {Promise<string|null>}
 */
export async function resolveGeplandeAankomstVensterFieldId(opts) {
  const baseUrl = String(opts?.baseUrl || '').trim();
  const apiKey = String(opts?.apiKey || '').trim();
  const locationId = String(opts?.locationId || ghlLocationIdFromEnv() || '').trim();
  if (!baseUrl || !apiKey || !locationId) return null;
  return resolveContactCustomFieldId({
    baseUrl,
    apiKey,
    locationId,
    fieldKey: VENSTER_FIELD_KEY,
    objectType: 'contact',
  });
}
