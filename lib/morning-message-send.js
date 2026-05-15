/**
 * Verstuurt ochtendmeldingen naar GHL (geplande aankomst + workflow-tag).
 */

import { fetchWithRetry } from './retry.js';
import { pulseContactTag } from './ghl-tag.js';
import { DEFAULT_BOOK_START_MORNING } from './planning-work-hours.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

/**
 * @param {Array<{ contactId: string, plannedValue?: string, timeFrom?: string, timeTo?: string }>} appointments
 * @param {{ apiKey: string, geplandeAankomstFieldId: string, fetchFn?: typeof fetch, tagName?: string }} deps
 */
export async function sendMorningMessagesBatch(appointments, deps) {
  const apiKey = String(deps?.apiKey || '').trim();
  const fieldId = String(deps?.geplandeAankomstFieldId || '').trim();
  const fetchFn = deps?.fetchFn || fetchWithRetry;
  const tagName = String(deps?.tagName || 'ochtend-melding').trim() || 'ochtend-melding';
  if (!apiKey || !fieldId) {
    return { ok: false, code: 'GHL_NOT_CONFIGURED', sent: 0, errors: ['missing_api_or_field'] };
  }

  const rows = Array.isArray(appointments) ? appointments : [];
  let sent = 0;
  const errors = [];

  for (const appt of rows) {
    const contactId = String(appt?.contactId || '').trim();
    if (!contactId) continue;
    const planned = String(
      appt.plannedValue || appt.timeFrom || appt.timeTo || DEFAULT_BOOK_START_MORNING
    ).trim();
    try {
      const res = await fetchFn(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-04-15',
        },
        body: JSON.stringify({
          customFields: [{ id: fieldId, field_value: planned }],
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        errors.push(`${contactId}: contact_put_${res.status} ${txt.slice(0, 120)}`);
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
