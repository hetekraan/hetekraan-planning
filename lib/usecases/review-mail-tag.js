const DEFAULT_GHL_BASE_URL = 'https://services.leadconnectorhq.com';
export const REVIEW_MAIL_TAG = 'review_mail_versturen';

function normalizeTagList(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map((entry) => {
      if (entry == null) return '';
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'object') return String(entry.name || entry.tag || entry.value || '').trim();
      return '';
    })
    .filter(Boolean);
}

export function shouldQueueReviewMailTag({ sendReview, status }) {
  const reviewEnabled = sendReview === true;
  const klaarClicked = String(status || '').trim().toLowerCase() === 'klaar';
  return reviewEnabled && klaarClicked;
}

export function contactHasTag(contact, tagName) {
  const expected = String(tagName || '').trim().toLowerCase();
  if (!expected) return false;
  const tags = normalizeTagList(contact?.tags || contact?.contact?.tags || []);
  return tags.some((t) => String(t).trim().toLowerCase() === expected);
}

function summarizeError(err) {
  if (!err) return 'unknown_error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function buildHeaders(apiKey, version = '2021-07-28') {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: version,
  };
}

async function fetchGhlContact({ contactId, baseUrl, apiKey, fetchImpl }) {
  const endpoint = `${baseUrl}/contacts/${encodeURIComponent(String(contactId).trim())}`;
  const res = await fetchImpl(endpoint, {
    method: 'GET',
    headers: buildHeaders(apiKey, '2021-04-15'),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`contact_fetch_failed_${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 400);
    throw err;
  }
  const payload = await res.json().catch(() => ({}));
  const contact = payload?.contact && typeof payload.contact === 'object' ? payload.contact : payload;
  if (!contact || typeof contact !== 'object') {
    const err = new Error('contact_missing_in_response');
    err.status = 502;
    throw err;
  }
  return contact;
}

async function addTagToContact({ contactId, tagName, baseUrl, apiKey, fetchImpl }) {
  const endpoint = `${baseUrl}/contacts/${encodeURIComponent(String(contactId).trim())}/tags`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ tags: [tagName] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`tag_add_failed_${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 400);
    throw err;
  }
}

function logReviewAutomation(event, payload) {
  try {
    console.info('[review_mail_automation]', JSON.stringify({ event, ...payload }));
  } catch (_) {}
}

export async function ensureReviewMailTagOnComplete({
  contactId,
  appointmentId,
  sendReview,
  status = 'klaar',
  fetchImpl = globalThis.fetch,
  apiKey = process.env.GHL_API_KEY,
  locationId = process.env.GHL_LOCATION_ID,
  baseUrl = process.env.GHL_BASE_URL || DEFAULT_GHL_BASE_URL,
  tagName = REVIEW_MAIL_TAG,
} = {}) {
  if (!shouldQueueReviewMailTag({ sendReview, status })) {
    logReviewAutomation('conditions_not_met', {
      contactId: contactId || null,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      sendReview: sendReview === true,
      status: String(status || ''),
      tagName,
    });
    return { attempted: false, reason: 'conditions_not_met', tagAdded: false };
  }

  const contactIdNorm = String(contactId || '').trim();
  if (!contactIdNorm) {
    // Skip (in plaats van hard fail): afspraak staat al op klaar en review-tag is een optionele automatisering.
    logReviewAutomation('missing_contact_id', {
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      sendReview: true,
      status: String(status || ''),
      tagName,
    });
    return { attempted: false, reason: 'missing_contact_id', tagAdded: false, error: 'missing_contact_id' };
  }

  if (!apiKey || !locationId) {
    logReviewAutomation('missing_env', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      hasApiKey: !!apiKey,
      hasLocationId: !!locationId,
      tagName,
    });
    return { attempted: false, reason: 'missing_env', tagAdded: false, error: 'missing_env' };
  }

  if (typeof fetchImpl !== 'function') {
    logReviewAutomation('missing_fetch_impl', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      tagName,
    });
    return { attempted: false, reason: 'missing_fetch_impl', tagAdded: false, error: 'missing_fetch_impl' };
  }

  try {
    logReviewAutomation('contact_lookup_started', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      lookupKey: 'contactId',
      tagName,
    });
    const contact = await fetchGhlContact({
      contactId: contactIdNorm,
      baseUrl,
      apiKey,
      fetchImpl,
    });

    logReviewAutomation('contact_found', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      lookupKey: 'contactId',
      matchResult: 'matched',
      ghlContactId: String(contact?.id || contactIdNorm),
      tagCount: Array.isArray(contact?.tags) ? contact.tags.length : 0,
      tagName,
    });

    if (contactHasTag(contact, tagName)) {
      const onRepeatCompletion = String(status || '').trim().toLowerCase() === 'klaar';
      if (onRepeatCompletion) {
        logReviewAutomation('tag_already_exists_on_repeat_completion', {
          contactId: contactIdNorm,
          appointmentId: appointmentId != null ? String(appointmentId) : null,
          tagName,
        });
      }
      logReviewAutomation('tag_already_exists', {
        contactId: contactIdNorm,
        appointmentId: appointmentId != null ? String(appointmentId) : null,
        tagName,
        repeatCompletion: onRepeatCompletion,
      });
      return { attempted: true, reason: 'tag_already_exists', tagAdded: false, repeatCompletion: onRepeatCompletion };
    }

    // Lifecycle-opmerking: we laten de trigger-tag staan. Deze flow is idempotent en gebruikt dedupe.
    // TODO(ghl-review): evalueer later of workflow/CRM beter werkt met nabehandeling
    // via 'review_mail_sent' status-tag of periodieke cleanup.
    await addTagToContact({
      contactId: contactIdNorm,
      tagName,
      baseUrl,
      apiKey,
      fetchImpl,
    });

    logReviewAutomation('tag_added', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      tagName,
    });
    return { attempted: true, reason: 'tag_added', tagAdded: true };
  } catch (err) {
    const statusCode = Number(err?.status) || null;
    const reason = statusCode === 404 ? 'contact_not_found' : 'request_failed';
    logReviewAutomation('contact_lookup_result', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      lookupKey: 'contactId',
      matchResult: reason === 'contact_not_found' ? 'not_found' : 'error',
      status: statusCode,
      tagName,
    });
    logReviewAutomation('failed', {
      contactId: contactIdNorm,
      appointmentId: appointmentId != null ? String(appointmentId) : null,
      reason,
      status: statusCode,
      error: summarizeError(err),
      detail: err?.body || undefined,
      tagName,
    });
    return {
      attempted: true,
      reason,
      tagAdded: false,
      error: summarizeError(err),
      status: statusCode,
    };
  }
}
