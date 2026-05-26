/**
 * Shared ranking for booking proposal candidates.
 * Keeps capacity eligibility untouched; only orders already-valid candidates.
 */

const SPOED_EARLY_DAY_OFFSET_MAX = 3;

function parseYmdUtc(ymd) {
  const m = String(ymd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
}

function dateOffsetDays(fromYmd, toYmd) {
  const a = parseYmdUtc(fromYmd);
  const b = parseYmdUtc(toYmd);
  if (a == null || b == null) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86400000);
}

export function estimateDriveMinutesFromKm(distanceKm, kmPerMinute = 0.9) {
  const km = Number(distanceKm);
  const kpm = Number(kmPerMinute);
  if (!Number.isFinite(km) || km < 0 || !Number.isFinite(kpm) || kpm <= 0) return Number.POSITIVE_INFINITY;
  return km / kpm;
}

function toTier({ dayOffset, driveMinutes, horizonDays, tierAMinutes, tierBMinutes }) {
  const withinHorizon = Number.isFinite(dayOffset) && dayOffset >= 0 && dayOffset <= horizonDays;
  if (withinHorizon && Number.isFinite(driveMinutes) && driveMinutes <= tierAMinutes) return 'A';
  if (withinHorizon && Number.isFinite(driveMinutes) && driveMinutes <= tierBMinutes) return 'B';
  return 'C';
}

function spoedTier({ dayOffset, driveMinutes, horizonDays, tierBMinutes }) {
  if (Number.isFinite(dayOffset) && dayOffset >= 0 && dayOffset <= SPOED_EARLY_DAY_OFFSET_MAX) return 'A';
  const withinHorizon = Number.isFinite(dayOffset) && dayOffset >= 0 && dayOffset <= horizonDays;
  if (withinHorizon && Number.isFinite(driveMinutes) && driveMinutes <= tierBMinutes) return 'B';
  return 'C';
}

function cmpClusteringFirst(a, b) {
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (a.driveMinutesEst !== b.driveMinutesEst) return a.driveMinutesEst - b.driveMinutesEst;
  if (a.evalScore !== b.evalScore) return b.evalScore - a.evalScore;
  return String(a.dateStr || '').localeCompare(String(b.dateStr || ''));
}

/** Legacy: clustering-heavy legacyScore (env PROPOSAL_RANKING_LEGACY=true). */
export function cmpLegacy(a, b) {
  return (a.legacyScore ?? 0) - (b.legacyScore ?? 0);
}

/** Default: earliest date, then clustering within day, then evalScore. */
export function cmpDateFirst(a, b) {
  const da = a.dateOffsetDays ?? Number.POSITIVE_INFINITY;
  const db = b.dateOffsetDays ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  const driveA = a.driveMinutesEst ?? Number.POSITIVE_INFINITY;
  const driveB = b.driveMinutesEst ?? Number.POSITIVE_INFINITY;
  if (driveA !== driveB) return driveA - driveB;
  const evalA = Number(a.evalScore ?? 0);
  const evalB = Number(b.evalScore ?? 0);
  if (evalA !== evalB) return evalA - evalB;
  const dateCmp = String(a.dateStr || '').localeCompare(String(b.dateStr || ''));
  if (dateCmp !== 0) return dateCmp;
  return String(a.block || '').localeCompare(String(b.block || ''));
}

/** Spoed: first days (offset ≤ 3) by date only; later days use cmpDateFirst. */
export function cmpSpoedDateFirst(a, b) {
  const da = a.dateOffsetDays ?? Number.POSITIVE_INFINITY;
  const db = b.dateOffsetDays ?? Number.POSITIVE_INFINITY;
  const aEarly = da <= SPOED_EARLY_DAY_OFFSET_MAX;
  const bEarly = db <= SPOED_EARLY_DAY_OFFSET_MAX;
  if (aEarly !== bEarly) return aEarly ? -1 : 1;
  if (aEarly && bEarly) {
    if (da !== db) return da - db;
    const dateCmp = String(a.dateStr || '').localeCompare(String(b.dateStr || ''));
    if (dateCmp !== 0) return dateCmp;
    return String(a.block || '').localeCompare(String(b.block || ''));
  }
  return cmpDateFirst(a, b);
}

function pickComparator({ enableClusteringFirst, enableLegacyRanking, spoedMode }) {
  if (spoedMode) return cmpSpoedDateFirst;
  if (enableClusteringFirst) return cmpClusteringFirst;
  if (enableLegacyRanking) return cmpLegacy;
  return cmpDateFirst;
}

export function rankProposalCandidates({
  candidates,
  nowDateStr,
  enableClusteringFirst = false,
  enableLegacyRanking = false,
  spoedMode = false,
  horizonDays = 14,
  tierAMinutes = 15,
  tierBMinutes = 25,
  kmPerMinute = 0.9,
}) {
  const base = Array.isArray(candidates) ? candidates : [];
  const enriched = base.map((c) => {
    const dayOffset = dateOffsetDays(nowDateStr, c?.dateStr);
    const driveMinutesFromCandidate = Number(c?.driveMinutesEst);
    const driveMinutesFromDistance = estimateDriveMinutesFromKm(c?.nearestDistanceKm, kmPerMinute);
    const driveMinutesEst = Number.isFinite(driveMinutesFromCandidate)
      ? driveMinutesFromCandidate
      : driveMinutesFromDistance;
    const tier = spoedMode
      ? spoedTier({ dayOffset, driveMinutes: driveMinutesEst, horizonDays, tierBMinutes })
      : toTier({
          dayOffset,
          driveMinutes: driveMinutesEst,
          horizonDays,
          tierAMinutes,
          tierBMinutes,
        });
    const tierRank = tier === 'A' ? 0 : tier === 'B' ? 1 : 2;
    return {
      ...c,
      dateOffsetDays: dayOffset,
      driveMinutesEst,
      tier,
      tierRank,
    };
  });

  const cmp = pickComparator({ enableClusteringFirst, enableLegacyRanking, spoedMode });
  const ranked = [...enriched].sort(cmp);
  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const c of enriched) tierCounts[c.tier] += 1;
  const top = ranked[0] || null;
  let mode = 'date_first';
  if (spoedMode) mode = 'spoed_date_first';
  else if (enableClusteringFirst) mode = 'clustering_first';
  else if (enableLegacyRanking) mode = 'legacy';

  return {
    ranked,
    mode,
    telemetry: {
      ranking_mode: mode,
      candidate_total: enriched.length,
      tier_A_count: tierCounts.A,
      tier_B_count: tierCounts.B,
      tier_C_count: tierCounts.C,
      selected_top_tier: top?.tier || null,
      selected_top_drive_min_est: Number.isFinite(top?.driveMinutesEst)
        ? Math.round(top.driveMinutesEst * 10) / 10
        : null,
      selected_top_date_offset_days: Number.isFinite(top?.dateOffsetDays) ? top.dateOffsetDays : null,
      top3_tiers: ranked.slice(0, 3).map((c) => c.tier),
    },
  };
}
