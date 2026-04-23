/**
 * Planner-side proposal constraints for Model B block offers (Europe/Amsterdam kalenderdagen).
 * Filtert (dateStr, block)-kandidaten vóór evaluateBlockOffer; default = geen constraints.
 */

import { amsterdamWeekdaySun0 } from './amsterdam-calendar-day.js';
import { blockOfferKey } from './block-capacity-offers.js';

/**
 * @typedef {0|1|2|3|4|5|6} WeekdaySun0
 */

/**
 * @typedef {object} ProposalConstraints
 * @property {string[]} [allowedDates]
 * @property {boolean} [datesOnly]
 * @property {WeekdaySun0[]} [allowedWeekdays]
 * @property {string[]} [excludedDates]
 * @property {string[]} [excludedOfferKeys]
 * @property {('morning'|'afternoon')[]} [allowedBlocks]
 * @property {number} [maxOptions]
 * @property {string} [scanStartDate]
 * @property {number} [scanHorizonDays]
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeProposalDateStr(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!YMD_RE.test(s)) return null;
  return s;
}

/**
 * @param {unknown} raw
 * @returns {ProposalConstraints|null}
 */
export function parseProposalConstraints(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  /** @type {ProposalConstraints} */
  const out = {};

  if (Array.isArray(raw.allowedDates)) {
    out.allowedDates = raw.allowedDates.map((x) => String(x).trim()).filter(Boolean);
  }
  if (raw.datesOnly === true) out.datesOnly = true;

  if (Array.isArray(raw.allowedWeekdays)) {
    out.allowedWeekdays = raw.allowedWeekdays
      .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
  }
  if (Array.isArray(raw.excludedDates)) {
    out.excludedDates = raw.excludedDates.map((x) => String(x).trim()).filter(Boolean);
  }
  if (Array.isArray(raw.excludedOfferKeys)) {
    out.excludedOfferKeys = raw.excludedOfferKeys.map((x) => String(x).trim()).filter(Boolean);
  }
  if (Array.isArray(raw.allowedBlocks)) {
    out.allowedBlocks = /** @type {('morning'|'afternoon')[]} */ (
      raw.allowedBlocks.filter((b) => b === 'morning' || b === 'afternoon')
    );
  }
  if (raw.maxOptions != null && raw.maxOptions !== '') {
    const m = typeof raw.maxOptions === 'number' ? raw.maxOptions : parseInt(String(raw.maxOptions), 10);
    if (Number.isFinite(m)) out.maxOptions = m;
  }
  if (raw.scanStartDate != null && String(raw.scanStartDate).trim()) {
    out.scanStartDate = String(raw.scanStartDate).trim();
  }
  if (raw.scanHorizonDays != null && raw.scanHorizonDays !== '') {
    const h = typeof raw.scanHorizonDays === 'number' ? raw.scanHorizonDays : parseInt(String(raw.scanHorizonDays), 10);
    if (Number.isFinite(h)) out.scanHorizonDays = h;
  }

  return Object.keys(out).length ? out : null;
}

function clampHorizonDays(h, defaultDays) {
  const v = h != null && Number.isFinite(Number(h)) ? Number(h) : defaultDays;
  return Math.min(60, Math.max(1, Math.round(v)));
}

/**
 * @param {ProposalConstraints|null|undefined} c
 * @param {number} defaultMax
 * @param {number} hardMax
 */
export function effectiveMaxOptions(c, defaultMax, hardMax) {
  if (c?.maxOptions == null) return defaultMax;
  const m = typeof c.maxOptions === 'number' ? c.maxOptions : parseInt(String(c.maxOptions), 10);
  if (!Number.isFinite(m)) return defaultMax;
  return Math.min(hardMax, Math.max(1, Math.round(m)));
}

/**
 * Rolling venster (Amsterdam) of vaste datums bij datesOnly + allowedDates.
 * @param {{ startDate: string, defaultHorizonDays: number, proposalConstraints: ProposalConstraints|null }} opts
 * @returns {{ kind: 'rolling', start: string, horizon: number } | { kind: 'list', dates: string[] }}
 */
export function buildProposalScanSchedule({ startDate, defaultHorizonDays, proposalConstraints }) {
  const c = proposalConstraints || null;
  const horizon = clampHorizonDays(c?.scanHorizonDays, defaultHorizonDays);
  const requestedStart = normalizeProposalDateStr(c?.scanStartDate);
  // Nooit eerder dan het standaard scanvenster van de caller (bijv. morgen in suggest-flow).
  const effStart = requestedStart && requestedStart > startDate ? requestedStart : startDate;

  if (c?.datesOnly === true && Array.isArray(c.allowedDates) && c.allowedDates.length > 0) {
    const dates = [];
    const seen = new Set();
    const minD = effStart;
    for (const raw of c.allowedDates) {
      const d = normalizeProposalDateStr(raw);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (minD && d < minD) continue;
      dates.push(d);
    }
    return { kind: 'list', dates };
  }

  return { kind: 'rolling', start: effStart, horizon };
}

/**
 * Gedeelde filter: mag dit (dateStr, block) als kandidaat? (Geen capacity-check.)
 * @param {string} dateStr
 * @param {'morning'|'afternoon'} block
 * @param {ProposalConstraints|null|undefined} constraints
 * @returns {boolean}
 */
export function proposalConstraintsPassCandidate(dateStr, block, constraints) {
  if (!constraints) return true;

  const d = normalizeProposalDateStr(dateStr);
  if (!d) return false;
  if (block !== 'morning' && block !== 'afternoon') return false;

  if (Array.isArray(constraints.excludedDates) && constraints.excludedDates.length > 0) {
    const ex = new Set(constraints.excludedDates.map((x) => normalizeProposalDateStr(x)).filter(Boolean));
    if (ex.has(d)) return false;
  }

  const minStart = normalizeProposalDateStr(constraints.scanStartDate);
  if (minStart && d < minStart) return false;

  if (Array.isArray(constraints.excludedOfferKeys) && constraints.excludedOfferKeys.length > 0) {
    const key = blockOfferKey(d, block);
    if (constraints.excludedOfferKeys.includes(key)) return false;
  }

  const hasAllowedDates = Array.isArray(constraints.allowedDates) && constraints.allowedDates.length > 0;
  if (hasAllowedDates && constraints.datesOnly !== true) {
    const allow = new Set(constraints.allowedDates.map((x) => normalizeProposalDateStr(x)).filter(Boolean));
    if (!allow.has(d)) return false;
  }

  if (Array.isArray(constraints.allowedWeekdays) && constraints.allowedWeekdays.length > 0) {
    const dow = amsterdamWeekdaySun0(d);
    if (!constraints.allowedWeekdays.includes(dow)) return false;
  }

  if (Array.isArray(constraints.allowedBlocks) && constraints.allowedBlocks.length > 0) {
    if (!constraints.allowedBlocks.includes(block)) return false;
  }

  return true;
}

/**
 * Blokken om te proberen in vaste volgorde.
 * @param {ProposalConstraints|null|undefined} constraints
 * @returns {('morning'|'afternoon')[]}
 */
export function proposalBlocksToEvaluate(constraints) {
  const all = /** @type {const} */ (['morning', 'afternoon']);
  if (!constraints?.allowedBlocks?.length) return [...all];
  return all.filter((b) => constraints.allowedBlocks.includes(b));
}
