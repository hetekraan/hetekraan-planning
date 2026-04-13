/**
 * Shared ranking for booking proposal candidates.
 * Keeps capacity eligibility untouched; only orders already-valid candidates.
 */

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

function cmpClusteringFirst(a, b) {
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (a.driveMinutesEst !== b.driveMinutesEst) return a.driveMinutesEst - b.driveMinutesEst;
  if (a.evalScore !== b.evalScore) return b.evalScore - a.evalScore;
  return String(a.dateStr || '').localeCompare(String(b.dateStr || ''));
}

function cmpLegacy(a, b) {
  return (a.legacyScore ?? 0) - (b.legacyScore ?? 0);
}

export function rankProposalCandidates({
  candidates,
  nowDateStr,
  enableClusteringFirst = false,
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
    const tier = toTier({
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

  const ranked = [...enriched].sort(enableClusteringFirst ? cmpClusteringFirst : cmpLegacy);
  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const c of enriched) tierCounts[c.tier] += 1;
  const top = ranked[0] || null;
  return {
    ranked,
    telemetry: {
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
