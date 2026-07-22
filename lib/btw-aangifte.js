/**
 * BTW-aangifte-herinnering — pure datumlogica, geen Moneybird-call.
 *
 * Aanname: Hetekraan doet kwartaalaangifte. De aangifte moet uiterlijk
 * ingediend/betaald zijn op de laatste dag van de maand ná het kwartaal:
 *   Q1 -> 30 april, Q2 -> 31 juli, Q3 -> 31 oktober, Q4 -> 31 januari (volgend jaar).
 *
 * Doet Hetekraan maandaangifte? Pas dan QUARTER_DEADLINES aan (of vervang door
 * maanddeadlines: uiterlijk de laatste dag van de volgende maand).
 */

// Aantal dagen vóór de deadline waarop de herinnering in de e-mail verschijnt.
// Makkelijk aan te passen.
export const BTW_REMINDER_DAYS_BEFORE = 10;

// Deadlines per kwartaal. `year: 'next'` betekent: hoort bij Q4 van het
// vórige jaar en valt in januari van het volgende kalenderjaar.
const QUARTER_DEADLINES = [
  { quarter: 'Q1', month: 4, day: 30 },
  { quarter: 'Q2', month: 7, day: 31 },
  { quarter: 'Q3', month: 10, day: 31 },
  { quarter: 'Q4', month: 1, day: 31 },
];

const NL_MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

function ymdToUtcMs(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

/** Aantal hele kalenderdagen van fromStr tot toStr (positief = toStr later). */
function daysBetween(fromStr, toStr) {
  const a = ymdToUtcMs(fromStr);
  const b = ymdToUtcMs(toStr);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** '2026-01-31' -> '31 januari 2026'. */
export function formatDutchDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return String(dateStr || '');
  return `${d} ${NL_MONTHS[m - 1]} ${y}`;
}

/**
 * Geeft een herinnering als vandaag binnen `daysBefore` dagen vóór (of op) een
 * BTW-deadline valt, anders null.
 *
 * @param {string} todayStr YYYY-MM-DD (Europe/Amsterdam kalenderdag)
 * @returns {{ quarter: string, deadline: string, deadlineLabel: string, daysUntil: number } | null}
 */
export function getBtwReminder(todayStr, { daysBefore = BTW_REMINDER_DAYS_BEFORE } = {}) {
  if (!todayStr) return null;
  const [year] = String(todayStr).split('-').map(Number);
  if (!year) return null;

  // Kandidaten uit dit én volgend jaar (Q4-deadline valt in januari).
  const candidates = [];
  for (const yr of [year, year + 1]) {
    for (const q of QUARTER_DEADLINES) {
      candidates.push({
        quarter: q.quarter,
        deadline: `${yr}-${pad2(q.month)}-${pad2(q.day)}`,
      });
    }
  }

  let best = null;
  for (const c of candidates) {
    const daysUntil = daysBetween(todayStr, c.deadline);
    if (daysUntil == null || daysUntil < 0) continue;
    if (daysUntil <= daysBefore && (!best || daysUntil < best.daysUntil)) {
      best = {
        quarter: c.quarter,
        deadline: c.deadline,
        deadlineLabel: formatDutchDate(c.deadline),
        daysUntil,
      };
    }
  }
  return best;
}
