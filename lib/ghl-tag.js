// GHL: tag kort verwijderen en opnieuw zetten zodat "Tag added" workflows opnieuw triggeren.

import { fetchWithRetry } from './retry.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

/** Zelfde API-versie als api/send-booking-invite.js (tags); 2021-04-15 gaf op sommige omgevingen geen zichtbare tag/custom-field wijziging. */
const GHL_TAGS_VERSION = '2021-07-28';

function summarizeTagResponseBody(text, max = 400) {
  const s = String(text || '').replace(/[\u0000-\u001f]+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function ghlTagAddResponseIndicatesSuccess(status, responseText) {
  if (status < 200 || status >= 300) return false;
  const t = String(responseText || '').trim();
  if (!t) return true;
  try {
    const j = JSON.parse(t);
    if (j && j.success === false) return false;
    if (j && j.ok === false) return false;
    if (String(j?.status || '').toLowerCase() === 'error') return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * @param {string} contactId
 * @param {string} tagName
 * @param {string} logTag
 * @param {{ on?: (event: string, payload: Record<string, unknown>) => void }} [hooks] — o.a. Moneybird structured logs
 * @returns {Promise<boolean>}
 */
export async function pulseContactTag(contactId, tagName, logTag = '[ghl-tag]', hooks) {
  const key = process.env.GHL_API_KEY;
  const locationId = String(process.env.GHL_LOCATION_ID || '').trim();
  const tagUrl = `${GHL_BASE}/contacts/${contactId}/tags`;
  if (!key || !contactId || !tagName) return false;

  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Version: GHL_TAGS_VERSION,
  };

  const emit = (event, payload) => {
    if (hooks && typeof hooks.on === 'function') {
      hooks.on(event, { contactId, tagName, locationId: locationId || undefined, ...payload });
    }
  };

  try {
    emit('ghl_tag_pulse_request', { endpoint: tagUrl, method: 'DELETE', step: 'delete' });
    const del = await fetchWithRetry(tagUrl, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ tags: [tagName] }),
    });
    const delText = await del.text().catch(() => '');
    emit('ghl_tag_pulse_response', {
      step: 'delete',
      httpStatus: del.status,
      responseBody: summarizeTagResponseBody(delText),
    });
    if (del.status === 401 || del.status === 403) {
      emit('ghl_tag_pulse_failed', { step: 'delete', httpStatus: del.status, reason: 'delete_unauthorized' });
      console.error(`${logTag} tag DELETE auth mislukt:`, del.status, summarizeTagResponseBody(delText));
      return false;
    }
    if (!del.ok && del.status !== 404) {
      emit('ghl_tag_pulse_failed', { step: 'delete', httpStatus: del.status, reason: 'delete_failed' });
      console.error(`${logTag} tag DELETE mislukt:`, del.status, summarizeTagResponseBody(delText));
      return false;
    }

    await new Promise((r) => setTimeout(r, 1500));

    emit('ghl_tag_pulse_request', { endpoint: tagUrl, method: 'POST', step: 'post' });
    const add = await fetchWithRetry(tagUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: [tagName] }),
    });
    const addText = await add.text().catch(() => '');
    emit('ghl_tag_pulse_response', {
      step: 'post',
      httpStatus: add.status,
      responseBody: summarizeTagResponseBody(addText),
    });

    const postOk = add.ok && ghlTagAddResponseIndicatesSuccess(add.status, addText);
    if (!postOk) {
      emit('ghl_tag_pulse_failed', { step: 'post', httpStatus: add.status, reason: 'post_failed_or_body_rejects' });
      console.error(`${logTag} tag POST mislukt:`, add.status, summarizeTagResponseBody(addText));
      return false;
    }
    emit('ghl_tag_pulse_success', { step: 'post', httpStatus: add.status });
    return true;
  } catch (e) {
    emit('ghl_tag_pulse_failed', { step: 'exception', message: e?.message || String(e) });
    console.error(`${logTag} pulseContactTag:`, e.message);
    return false;
  }
}
