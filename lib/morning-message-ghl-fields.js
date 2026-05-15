/**
 * GHL custom field ids voor ochtendmeldingen (dynamisch via API-lijst).
 */

import { resolveContactCustomFieldId } from './ghl-custom-fields.js';
import { ghlLocationIdFromEnv } from './ghl-env-ids.js';

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
    fieldKey: 'geplande_aankomst_venster',
    objectType: 'contact',
  });
}
