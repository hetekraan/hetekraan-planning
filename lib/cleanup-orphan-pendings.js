/**
 * Verwijder pending Redis-holds die bij 2-slot invites horen (optie 2 ingevuld in GHL).
 */

import { BOOKING_FORM_FIELD_IDS } from './booking-canon-fields.js';
import {
  listAllPendingReservations,
  removeReservationById,
} from './block-reservation-store.js';
import { invalidateRedisSyntheticsCacheForDate } from './amsterdam-day-read-cache.js';
import { fetchWithRetry } from './retry.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

function cleanString(value) {
  return String(value || '').trim();
}

function getContactField(contact, fieldId) {
  const fid = String(fieldId || '').trim();
  if (!contact?.customFields || !fid) return '';
  const f = contact.customFields.find(
    (x) => x.id === fid || x.fieldId === fid || x.customFieldId === fid
  );
  if (!f) return '';
  return cleanString(f.value ?? f.field_value ?? '');
}

export function isTwoSlotInviteContact(contact) {
  const opt2 = getContactField(contact, BOOKING_FORM_FIELD_IDS.boekingsvoorstel_optie_2);
  return Boolean(opt2);
}

/**
 * @param {{
 *   apiKey: string,
 *   fetchFn?: typeof fetch,
 *   dryRun?: boolean,
 *   listPendingFn?: () => Promise<Array<import('./block-reservation-store.js').BlockReservation>>,
 *   removeFn?: (row: object) => Promise<void>,
 *   invalidateFn?: (dateStr: string) => void,
 * }} deps
 */
export async function cleanupOrphanPendingReservations(deps) {
  const apiKey = cleanString(deps?.apiKey);
  const fetchFn = deps?.fetchFn || fetchWithRetry;
  const dryRun = deps?.dryRun === true;
  const listPendingFn = deps?.listPendingFn || listAllPendingReservations;
  const removeFn = deps?.removeFn || removeReservationById;
  const invalidateFn = deps?.invalidateFn || invalidateRedisSyntheticsCacheForDate;

  if (!apiKey) {
    return { ok: false, code: 'NO_API_KEY', removed: [], skipped: [], errors: [] };
  }

  const pendingRows = await listPendingFn();
  /** @type {Array<{ contactId: string, dateStr: string, reservationId: string, reason: string }>} */
  const removed = [];
  /** @type {Array<{ contactId: string, dateStr: string, reservationId: string, reason: string }>} */
  const skipped = [];
  /** @type {Array<{ contactId: string, reservationId: string, error: string }>} */
  const errors = [];

  for (const row of pendingRows) {
    const contactId = cleanString(row?.contactId);
    const dateStr = cleanString(row?.dateStr);
    const reservationId = cleanString(row?.id);
    if (!contactId || !dateStr || !reservationId) {
      skipped.push({
        contactId: contactId || '(missing)',
        dateStr: dateStr || '(missing)',
        reservationId: reservationId || '(missing)',
        reason: 'bad_row',
      });
      continue;
    }

    let contact = null;
    try {
      const r = await fetchFn(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-04-15',
        },
      });
      if (!r.ok) {
        errors.push({
          contactId,
          reservationId,
          error: `ghl_get_${r.status}`,
        });
        continue;
      }
      const data = await r.json().catch(() => ({}));
      contact = data?.contact ?? data ?? null;
    } catch (err) {
      errors.push({
        contactId,
        reservationId,
        error: err?.message || String(err),
      });
      continue;
    }

    if (!isTwoSlotInviteContact(contact)) {
      skipped.push({
        contactId,
        dateStr,
        reservationId,
        reason: 'not_two_slot_invite',
      });
      continue;
    }

    if (dryRun) {
      removed.push({
        contactId,
        dateStr,
        reservationId,
        reason: 'dry_run_would_remove',
      });
      continue;
    }

    try {
      await removeFn(row);
      invalidateFn(dateStr);

      const clearFields = [
        { id: BOOKING_FORM_FIELD_IDS.boeking_bevestigd_datum, field_value: '' },
        { id: BOOKING_FORM_FIELD_IDS.boeking_bevestigd_dagdeel, field_value: '' },
        { id: BOOKING_FORM_FIELD_IDS.boeking_bevestigd_status, field_value: '' },
      ];
      const putRes = await fetchFn(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-04-15',
        },
        body: JSON.stringify({ customFields: clearFields }),
      });
      if (!putRes.ok) {
        const t = await putRes.text().catch(() => '');
        errors.push({
          contactId,
          reservationId,
          error: `ghl_clear_${putRes.status}:${t.slice(0, 120)}`,
        });
      }

      console.log('[cleanup] orphan_pending_removed', {
        contactId,
        dateStr,
        reservationId,
        block: row?.block || null,
      });
      removed.push({
        contactId,
        dateStr,
        reservationId,
        reason: 'orphan_two_slot',
      });
    } catch (err) {
      errors.push({
        contactId,
        reservationId,
        error: err?.message || String(err),
      });
    }
  }

  return {
    ok: true,
    dryRun,
    scanned: pendingRows.length,
    removedCount: removed.length,
    removed,
    skipped,
    errors,
  };
}
