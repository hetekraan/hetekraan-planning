// GHL: tag kort verwijderen en opnieuw zetten zodat "Tag added" workflows opnieuw triggeren.

import { fetchWithRetry } from './retry.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

/**
 * @param {string} contactId
 * @param {string} tagName
 * @param {string} logTag
 * @returns {Promise<boolean>}
 */
export async function pulseContactTag(contactId, tagName, logTag = '[ghl-tag]') {
  const key = process.env.GHL_API_KEY;
  if (!key || !contactId || !tagName) return false;

  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };

  try {
    await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ tags: [tagName] }),
    });
    await new Promise((r) => setTimeout(r, 1500));
    const add = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: [tagName] }),
    });
    if (!add.ok) {
      const t = await add.text().catch(() => '');
      console.error(`${logTag} tag POST mislukt:`, add.status, t.slice(0, 300));
    }
    return add.ok;
  } catch (e) {
    console.error(`${logTag} pulseContactTag:`, e.message);
    return false;
  }
}
