/**
 * Verstuurt ochtendmeldingen naar GHL (geplande aankomst + vensterzin + workflow-tag).
 */

import { fetchWithRetry } from './retry.js';
import { pulseContactTag } from './ghl-tag.js';
import { DEFAULT_BOOK_START_MORNING } from './planning-work-hours.js';
import {
  listContactCustomFieldKeysForLookup,
  resolveGeplandeAankomstVensterFieldId,
  VENSTER_FIELD_KEY,
} from './morning-message-ghl-fields.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

let warnedMissingVensterField = false;

function logMorningMessageDebug(event, payload) {
  console.info(`[morning-message] ${event}`, JSON.stringify(payload));
}

/** @param {Array<{ id?: string, field_value?: string }>} customFields */
function buildGhlPutPayloadDebug(customFields) {
  const arr = Array.isArray(customFields) ? customFields : [];
  return {
    customFieldsCount: arr.length,
    fieldIds: arr.map((f) => String(f?.id || '')),
    firstThreeFieldIds: arr.slice(0, 3).map((f) => ({
      id: String(f?.id || ''),
      value: String(f?.field_value ?? '').slice(0, 80),
    })),
  };
}

/**
 * @param {Array<{
 *   contactId: string,
 *   plannedValue?: string,
 *   windowPhrase?: string,
 *   timeFrom?: string,
 *   timeTo?: string,
 * }>} appointments
 * @param {{
 *   apiKey: string,
 *   geplandeAankomstFieldId: string,
 *   geplandeAankomstVensterFieldId?: string|null,
 *   baseUrl?: string,
 *   locationId?: string,
 *   fetchFn?: typeof fetch,
 *   tagName?: string,
 * }} deps
 */
export async function sendMorningMessagesBatch(appointments, deps) {
  const apiKey = String(deps?.apiKey || '').trim();
  const fieldId = String(deps?.geplandeAankomstFieldId || '').trim();
  const fetchFn = deps?.fetchFn || fetchWithRetry;
  const tagName = String(deps?.tagName || 'ochtend-melding').trim() || 'ochtend-melding';
  if (!apiKey || !fieldId) {
    return { ok: false, code: 'GHL_NOT_CONFIGURED', sent: 0, errors: ['missing_api_or_field'] };
  }

  let vensterFieldId =
    deps.geplandeAankomstVensterFieldId !== undefined
      ? String(deps.geplandeAankomstVensterFieldId || '').trim() || null
      : null;
  if (vensterFieldId === null && deps.baseUrl && deps.locationId) {
    vensterFieldId = await resolveGeplandeAankomstVensterFieldId({
      baseUrl: deps.baseUrl,
      apiKey,
      locationId: deps.locationId,
    });
  }
  if (!vensterFieldId && !warnedMissingVensterField) {
    warnedMissingVensterField = true;
    console.warn(
      '[morning-message] geplande_aankomst_venster field not found; venster writes skipped',
      JSON.stringify({ fieldKey: 'geplande_aankomst_venster' })
    );
  }

  const rows = Array.isArray(appointments) ? appointments : [];
  let sent = 0;
  const errors = [];
  /** @type {string[]|null} */
  let availableKeysForDebug = null;
  const loadAvailableKeysForDebug = async () => {
    if (availableKeysForDebug !== null) return availableKeysForDebug;
    if (deps.baseUrl && deps.locationId) {
      availableKeysForDebug = await listContactCustomFieldKeysForLookup({
        baseUrl: deps.baseUrl,
        apiKey,
        locationId: deps.locationId,
      });
    } else {
      availableKeysForDebug = [];
    }
    return availableKeysForDebug;
  };

  for (const appt of rows) {
    const contactId = String(appt?.contactId || '').trim();
    if (!contactId) continue;
    const startTime = String(
      appt.plannedValue || appt.timeFrom || appt.timeTo || DEFAULT_BOOK_START_MORNING
    ).trim();
    const windowPhrase = String(appt.windowPhrase || '').trim();
    if (vensterFieldId) {
      logMorningMessageDebug('venster_field_id_resolved', {
        contactId,
        fieldId: vensterFieldId,
        fieldKey: VENSTER_FIELD_KEY,
      });
    } else {
      logMorningMessageDebug('venster_field_id_NOT_FOUND', {
        contactId,
        lookupKey: VENSTER_FIELD_KEY,
        availableKeys: await loadAvailableKeysForDebug(),
      });
    }
    const customFields = [{ id: fieldId, field_value: startTime }];
    if (vensterFieldId && windowPhrase) {
      customFields.push({ id: vensterFieldId, field_value: windowPhrase });
    }
    const putBody = { customFields };
    logMorningMessageDebug('ghl_contact_put_payload', {
      contactId,
      ...buildGhlPutPayloadDebug(customFields),
    });
    try {
      const res = await fetchFn(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-04-15',
        },
        body: JSON.stringify(putBody),
      });
      const responseText = await res.text().catch(() => '');
      logMorningMessageDebug('ghl_contact_put_response', {
        contactId,
        status: res.status,
        bodySnippet: responseText.slice(0, 200),
      });
      if (!res.ok) {
        errors.push(`${contactId}: contact_put_${res.status} ${responseText.slice(0, 120)}`);
        continue;
      }
      const tagOk = await pulseContactTag(contactId, tagName, '[morning-message-send]');
      if (!tagOk) {
        errors.push(`${contactId}: tag_pulse_failed`);
        continue;
      }
      sent += 1;
    } catch (err) {
      errors.push(`${contactId}: ${err?.message || String(err)}`);
    }
  }

  return { ok: errors.length === 0, sent, errors, total: rows.length };
}

/** Test helper: reset one-shot warning flag. */
export function resetMorningMessageSendWarningsForTests() {
  warnedMissingVensterField = false;
}
