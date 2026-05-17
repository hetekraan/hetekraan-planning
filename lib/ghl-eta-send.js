/**
 * GHL: geplande aankomst + monteur-eta workflow-tag.
 */

import { fetchWithRetry } from './retry.js';
import { addContactTag } from './ghl-tag.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_GEPLANDE_AANKOMST_FIELD_ID = 'XELcOSdWq3tqRtpLE5x8';

/**
 * @param {{
 *   apiKey: string,
 *   contactId: string,
 *   etaStr: string,
 *   geplandeAankomstFieldId?: string,
 *   tagName?: string,
 *   fetchFn?: typeof fetch,
 *   logPrefix?: string,
 * }} opts
 */
export async function sendGeplandeAankomstEtaToContact(opts) {
  const apiKey = String(opts?.apiKey || '').trim();
  const contactId = String(opts?.contactId || '').trim();
  const etaStr = String(opts?.etaStr || '').trim();
  const fieldId = String(opts?.geplandeAankomstFieldId || DEFAULT_GEPLANDE_AANKOMST_FIELD_ID).trim();
  const tagName = String(opts?.tagName || process.env.GHL_ETA_WORKFLOW_TAG || 'monteur-eta').trim();
  const fetchFn = opts?.fetchFn || fetchWithRetry;
  const logPrefix = String(opts?.logPrefix || '[ghl-eta-send]');

  if (!apiKey || !contactId || !etaStr || !fieldId) {
    return { ok: false, code: 'GHL_NOT_CONFIGURED' };
  }

  const putBody = { customFields: [{ id: fieldId, field_value: etaStr }] };
  const putRes = await fetchFn(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15',
    },
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) {
    const detail = (await putRes.text().catch(() => '')).slice(0, 400);
    return { ok: false, code: 'GHL_PUT_FAILED', status: putRes.status, detail };
  }

  await new Promise((r) => setTimeout(r, 400));
  const tagOk = await addContactTag(contactId, tagName, logPrefix, undefined, { apiKey, fetchFn });
  if (!tagOk) {
    return { ok: false, code: 'GHL_TAG_FAILED', workflowTag: tagName };
  }
  return { ok: true, workflowTag: tagName, putBody };
}
