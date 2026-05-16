/**
 * Day-scoped ETA-sent metadata for planner cards (route-live-state only).
 */

export function normalizeTimeStrForEta(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function buildEtaSentMetaBucket(routeState) {
  if (!routeState || typeof routeState !== 'object') return {};
  const raw =
    routeState.etaSentByContactId && typeof routeState.etaSentByContactId === 'object'
      ? routeState.etaSentByContactId
      : {};
  const bucket = {};
  for (const [cid, val] of Object.entries(raw)) {
    const id = String(cid || '').trim();
    const eta = normalizeTimeStrForEta(val && typeof val === 'object' ? val.eta : val);
    if (!id || !eta) continue;
    const sentAt = Number(val && typeof val === 'object' ? val.sentAt : 0);
    bucket[id] = {
      eta,
      sentAt: Number.isFinite(sentAt) && sentAt > 0 ? Math.floor(sentAt) : 0,
    };
  }
  return bucket;
}

export function getEtaSentMetaFromBucket(bucket, contactId) {
  const cid = String(contactId || '').trim();
  if (!cid || !bucket || typeof bucket !== 'object') return null;
  const hit = bucket[cid];
  return hit && hit.eta ? hit : null;
}

/**
 * @param {string} contactId
 * @param {string} dateStr
 * @param {(dateStr: string) => object|null|undefined} getRouteStateForDate
 */
export function getEtaSentMetaForContactFromRouteState(contactId, dateStr, getRouteStateForDate) {
  const ds = String(dateStr || '').trim();
  const cid = String(contactId || '').trim();
  if (!ds || !cid) return null;
  const state =
    typeof getRouteStateForDate === 'function' ? getRouteStateForDate(ds) : null;
  if (!state || typeof state !== 'object') return null;
  const bucket = buildEtaSentMetaBucket(state);
  const meta = getEtaSentMetaFromBucket(bucket, cid);
  if (!meta) return null;
  return {
    eta: meta.eta,
    sentAt: meta.sentAt > 0 ? meta.sentAt : Date.now(),
  };
}

/**
 * @param {object|null} routeState
 * @param {string} contactId
 * @param {string} eta
 * @param {number} sentAt
 */
export function patchRouteStateEtaSent(routeState, contactId, eta, sentAt) {
  const cid = String(contactId || '').trim();
  const etaNorm = normalizeTimeStrForEta(eta);
  if (!cid || !etaNorm) return routeState;
  const base = routeState && typeof routeState === 'object' ? routeState : {};
  const sent = Number(sentAt) > 0 ? Math.floor(sentAt) : Date.now();
  return {
    ...base,
    etaSentByContactId: {
      ...(base.etaSentByContactId && typeof base.etaSentByContactId === 'object'
        ? base.etaSentByContactId
        : {}),
      [cid]: { eta: etaNorm, sentAt: sent },
    },
  };
}
