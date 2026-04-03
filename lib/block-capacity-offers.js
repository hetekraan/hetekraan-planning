/**
 * Model B — block-capacity offers (Phase 1, self-contained).
 *
 * Customers book **dateStr + block** (morning 09:00–13:00 / afternoon 13:00–17:00), not GHL free-slots.
 * Availability = this module’s rules on **calendar events** + caller-supplied **day blocked** flag.
 *
 * Not wired to HTTP routes yet; callers must fetch `events` and `dayBlocked` separately.
 */

import {
  BLOCK_PLANNED_MINUTES_TOTAL,
  blockAllowsNewCustomerBooking,
  blockPlannedMinutesUsed,
  customerMaxForBlock,
  ghlDurationMinutesForType,
  normalizeWorkType,
  plannedMinutesForType,
} from './booking-blocks.js';
import { maxCustomerAppointmentsPerDay } from './calendar-customer-cap.js';
import { hourInAmsterdam } from './amsterdam-calendar-day.js';
import { markBlockLikeOnCalendarEvents } from './ghl-calendar-blocks.js';
import {
  DAYPART_SPLIT_HOUR,
  SLOT_LABEL_AFTERNOON_NL,
  SLOT_LABEL_AFTERNOON_SPACE,
  SLOT_LABEL_MORNING_NL,
  SLOT_LABEL_MORNING_SPACE,
} from './planning-work-hours.js';

/** @typedef {'morning'|'afternoon'} CustomerBlock */

/**
 * @typedef {object} BlockCapacityState
 * @property {number} dayCustomerCount — klant-achtige events (geen block-like), hele dag
 * @property {number} blockCustomerCount — zelfde, gefilterd op gekozen blok
 * @property {number} maxPerDay
 * @property {number} maxCustomersInBlock — uit booking-blocks (4 / 3)
 * @property {number} plannedMinutesInBlock — som geschatte geplande minuten in blok
 * @property {number} minutesNeededForNewBooking — voor dit workType
 * @property {number} plannedMinutesBudget — 240
 * @property {number} plannedMinutesRemainingInBlock — budget − used (vóór nieuwe boeking)
 */

/**
 * @typedef {object} BlockOfferEvaluation
 * @property {boolean} eligible
 * @property {'day_blocked'|'day_cap'|'block_capacity'|'invalid_input'} [reason]
 * @property {number} [score] — lager = betere rang (alleen bij eligible)
 * @property {BlockCapacityState} state
 */

/**
 * @typedef {object} EvaluateBlockOfferInput
 * @property {string} dateStr — YYYY-MM-DD (Amsterdam kalenderdag; ter identiteit & logging)
 * @property {CustomerBlock} block
 * @property {string} [workType] — ruwe string; genormaliseerd via normalizeWorkType
 * @property {object[]} [events] — ruwe GHL calendar events voor die dag (zelfde dag als dateStr)
 * @property {boolean} [dayBlocked] — true als isCustomerBookingBlockedOnAmsterdamDate (caller bepaalt)
 * @property {number} [maxPerDay] — default maxCustomerAppointmentsPerDay()
 * @property {{ penalizeSplitBlocks?: boolean }} [options] — heuristieken
 */

export const BLOCK_REASON = {
  DAY_BLOCKED: 'day_blocked',
  DAY_CAP: 'day_cap',
  BLOCK_CAPACITY: 'block_capacity',
  INVALID_INPUT: 'invalid_input',
};

export const CUSTOMER_BLOCK = {
  MORNING: 'morning',
  AFTERNOON: 'afternoon',
};

/**
 * Stabiele id voor token / UI: `YYYY-MM-DD_morning` | `YYYY-MM-DD_afternoon`
 * @param {string} dateStr
 * @param {CustomerBlock} block
 */
export function blockOfferKey(dateStr, block) {
  return `${dateStr}_${block}`;
}

/**
 * Parse `blockOfferKey` terug; mislukking → null
 * @param {string} key
 * @returns {{ dateStr: string, block: CustomerBlock } | null}
 */
export function parseBlockOfferKey(key) {
  const m = String(key || '').match(/^(\d{4}-\d{2}-\d{2})_(morning|afternoon)$/);
  if (!m) return null;
  return { dateStr: m[1], block: /** @type {CustomerBlock} */ (m[2]) };
}

/** Zelfde start-velden als confirm-booking eventStartRawForBooking (lokaal, geen import-cyclus). */
export function eventStartRawForBlock(e) {
  return (
    e?.startTime ??
    e?.start_time ??
    e?.start ??
    e?.appointmentStartTime ??
    e?.appointment?.startTime ??
    e?.calendarEvent?.startTime
  );
}

/**
 * Hoort event (start) bij ochtend- of middagblok? Split op DAYPART_SPLIT_HOUR (13).
 * @param {object} e
 * @param {CustomerBlock} block
 */
export function isEventInCustomerBlock(e, block) {
  const raw = eventStartRawForBlock(e);
  if (raw == null) return false;
  const h = hourInAmsterdam(raw);
  return block === 'morning' ? h < DAYPART_SPLIT_HOUR : h >= DAYPART_SPLIT_HOUR;
}

/**
 * Kopie + markBlockLike — muteert niet de array van de caller.
 * @param {object[]} events
 * @returns {object[]}
 */
export function prepareDayEvents(events) {
  const copy = Array.isArray(events) ? [...events] : [];
  markBlockLikeOnCalendarEvents(copy);
  return copy;
}

/**
 * @param {object[]} customerEvents — na prepareDayEvents, al gefilterd zonder block-like
 * @param {CustomerBlock} block
 * @param {string} workTypeNorm — genormaliseerd type
 * @param {number} maxPerDay
 * @returns {BlockCapacityState}
 */
export function buildBlockCapacityState(customerEvents, block, workTypeNorm, maxPerDay) {
  const blockEvents = customerEvents.filter((e) => isEventInCustomerBlock(e, block));
  const used = blockPlannedMinutesUsed(blockEvents);
  const need = plannedMinutesForType(workTypeNorm);
  return {
    dayCustomerCount: customerEvents.length,
    blockCustomerCount: blockEvents.length,
    maxPerDay,
    maxCustomersInBlock: customerMaxForBlock(block),
    plannedMinutesInBlock: used,
    minutesNeededForNewBooking: need,
    plannedMinutesBudget: BLOCK_PLANNED_MINUTES_TOTAL,
    plannedMinutesRemainingInBlock: BLOCK_PLANNED_MINUTES_TOTAL - used,
  };
}

/**
 * v1 score: **lager = beter rang**.
 * Clustering-heuristiek: voorkeur voor blokken die al klant-afspraken hebben (zelfde dagdeel vullen);
 * leeg ochtend + drukke middag (of omgekeerd) krijgt extra penalty (“split across day parts”).
 *
 * @param {object[]} blockCustomerEvents
 * @param {object[]} allCustomerEvents
 * @param {CustomerBlock} block
 * @param {{ penalizeSplitBlocks?: boolean }} [options]
 */
export function scoreBlockOffer(blockCustomerEvents, allCustomerEvents, block, options = {}) {
  const used = blockPlannedMinutesUsed(blockCustomerEvents);
  const count = blockCustomerEvents.length;
  const base = 500 - count * 120 - used * 0.4;

  let splitPenalty = 0;
  if (options.penalizeSplitBlocks !== false) {
    const other = block === CUSTOMER_BLOCK.MORNING ? CUSTOMER_BLOCK.AFTERNOON : CUSTOMER_BLOCK.MORNING;
    const otherCount = allCustomerEvents.filter((e) => isEventInCustomerBlock(e, other)).length;
    if (count === 0 && otherCount > 0) splitPenalty = 80;
  }

  return Math.round(base + splitPenalty);
}

/**
 * NL-labels voor klantteksten (custom fields / suggest later).
 * @param {CustomerBlock} block
 */
export function blockDisplayLabels(block) {
  const isM = block === CUSTOMER_BLOCK.MORNING;
  return {
    blockLabelNl: isM ? 'ochtend' : 'middag',
    slotLabelDash: isM ? SLOT_LABEL_MORNING_NL : SLOT_LABEL_AFTERNOON_NL,
    slotLabelSpace: isM ? SLOT_LABEL_MORNING_SPACE : SLOT_LABEL_AFTERNOON_SPACE,
  };
}

/**
 * Hoofd-evaluator: mag deze (dateStr, block) nog een klantboeking (dit workType) ontvangen?
 *
 * @param {EvaluateBlockOfferInput} input
 * @returns {BlockOfferEvaluation}
 */
export function evaluateBlockOffer(input) {
  const {
    dateStr,
    block,
    workType,
    events = [],
    dayBlocked = false,
    maxPerDay: maxPerDayIn,
    options = {},
  } = input || {};

  const emptyState = () => {
    const b =
      block === CUSTOMER_BLOCK.MORNING || block === CUSTOMER_BLOCK.AFTERNOON
        ? block
        : CUSTOMER_BLOCK.MORNING;
    return {
      dayCustomerCount: 0,
      blockCustomerCount: 0,
      maxPerDay: maxPerDayIn ?? maxCustomerAppointmentsPerDay(),
      maxCustomersInBlock: customerMaxForBlock(b),
      plannedMinutesInBlock: 0,
      minutesNeededForNewBooking: plannedMinutesForType(normalizeWorkType(workType)),
      plannedMinutesBudget: BLOCK_PLANNED_MINUTES_TOTAL,
      plannedMinutesRemainingInBlock: BLOCK_PLANNED_MINUTES_TOTAL,
    };
  };

  if (!dateStr || typeof dateStr !== 'string' || (block !== CUSTOMER_BLOCK.MORNING && block !== CUSTOMER_BLOCK.AFTERNOON)) {
    return {
      eligible: false,
      reason: BLOCK_REASON.INVALID_INPUT,
      state: emptyState(),
    };
  }

  const workTypeNorm = normalizeWorkType(workType);
  const maxPerDay = maxPerDayIn ?? maxCustomerAppointmentsPerDay();

  if (dayBlocked) {
    const marked = prepareDayEvents(events);
    const customerEvents = marked.filter((e) => !e._hkGhlBlockSlot);
    return {
      eligible: false,
      reason: BLOCK_REASON.DAY_BLOCKED,
      state: buildBlockCapacityState(customerEvents, block, workTypeNorm, maxPerDay),
    };
  }

  const marked = prepareDayEvents(events);
  const customerEvents = marked.filter((e) => !e._hkGhlBlockSlot);

  if (customerEvents.length >= maxPerDay) {
    return {
      eligible: false,
      reason: BLOCK_REASON.DAY_CAP,
      state: buildBlockCapacityState(customerEvents, block, workTypeNorm, maxPerDay),
    };
  }

  const blockEvents = customerEvents.filter((e) => isEventInCustomerBlock(e, block));

  if (!blockAllowsNewCustomerBooking(block, blockEvents, workTypeNorm)) {
    return {
      eligible: false,
      reason: BLOCK_REASON.BLOCK_CAPACITY,
      state: buildBlockCapacityState(customerEvents, block, workTypeNorm, maxPerDay),
    };
  }

  const score = scoreBlockOffer(blockEvents, customerEvents, block, options);

  return {
    eligible: true,
    score,
    state: buildBlockCapacityState(customerEvents, block, workTypeNorm, maxPerDay),
  };
}

/**
 * Evalueert ochtend en middag voor één dag (zelfde events + dayBlocked).
 * @param {Omit<EvaluateBlockOfferInput, 'block'>} input
 * @returns {{ block: CustomerBlock, evaluation: BlockOfferEvaluation }[]}
 */
export function evaluateBothBlocksForDate(input) {
  const blocks = [CUSTOMER_BLOCK.MORNING, CUSTOMER_BLOCK.AFTERNOON];
  return blocks.map((block) => ({
    block,
    evaluation: evaluateBlockOffer({ ...input, block }),
  }));
}

/**
 * Alleen paren waar eligible; gesorteerd op score (laag eerst).
 * @param {Omit<EvaluateBlockOfferInput, 'block'>} input
 */
export function listEligibleBlockOffersForDateSorted(input) {
  const rows = evaluateBothBlocksForDate(input)
    .filter((r) => r.evaluation.eligible)
    .sort((a, b) => (a.evaluation.score ?? 0) - (b.evaluation.score ?? 0));
  return rows;
}

/**
 * Hulp voor logging / UI: duur in minuten voor dit type (zelfde als booking-blocks / GHL).
 * @param {string} workType
 */
export function bookingDurationMinutesForDisplay(workType) {
  return ghlDurationMinutesForType(workType);
}
