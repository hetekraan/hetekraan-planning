(function () {
  function normalizeInternalFixedPin(raw, normalizeTimeStr) {
    if (!raw) return null;
    if (typeof raw === 'object') {
      const type = String(raw.type || '').trim().toLowerCase();
      const time = normalizeTimeStr(String(raw.time || '').replace(/^~/, ''));
      if ((type === 'exact' || type === 'after' || type === 'before') && /^\d{2}:\d{2}$/.test(time)) {
        return { type, time };
      }
      return null;
    }
    const legacy = normalizeTimeStr(String(raw || '').replace(/^~/, ''));
    if (!/^\d{2}:\d{2}$/.test(legacy)) return null;
    return { type: 'exact', time: legacy };
  }

  function readSnapshot(snapshotKey) {
    try {
      const raw = localStorage.getItem(snapshotKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function makeByContactId(appointments, normalizeTimeStr) {
    const byContactId = {};
    for (const a of appointments || []) {
      if (!a?.contactId) continue;
      const slot = a.timeSlot ? normalizeTimeStr(String(a.timeSlot).replace(/^~/, '')) : '';
      const pin =
        normalizeInternalFixedPin(a.internalFixedPin, normalizeTimeStr) ||
        normalizeInternalFixedPin(a.internalFixedStartTime, normalizeTimeStr);
      const internal = pin?.time || '';
      if (!slot && !internal) continue;
      const row = {};
      if (slot) {
        row.timeSlot = slot;
        row.estimated = !!a.estimated;
      }
      if (pin) row.internalFixedStartTime = pin;
      byContactId[a.contactId] = row;
    }
    return byContactId;
  }

  function routeRefactorEnabled(input) {
    if (input && Object.prototype.hasOwnProperty.call(input, 'routeRefactorEnabled')) {
      return input.routeRefactorEnabled !== false;
    }
    try {
      return window.HK_ROUTE_REFACTOR_ENABLED !== false;
    } catch (_) {
      return true;
    }
  }

  function normalizeRouteLocalDraft(raw) {
    if (!raw) return null;
    const orderRaw = Array.isArray(raw.contactIdsOrder)
      ? raw.contactIdsOrder
      : Array.isArray(raw.orderContactIds)
        ? raw.orderContactIds
        : [];
    const order = orderRaw.map((x) => String(x || '').trim()).filter(Boolean);
    const etas = raw.etasByContactId && typeof raw.etasByContactId === 'object' ? raw.etasByContactId : {};
    if (!order.length && !Object.keys(etas).length) return null;
    const internalRaw = raw.internalFixedStartByContactId;
    const internalFixedStartByContactId =
      internalRaw && typeof internalRaw === 'object'
        ? Object.fromEntries(
            Object.entries(internalRaw)
              .map(([k, v]) => [String(k || '').trim(), normalizeInternalFixedPin(v, (x) => x)])
              .filter(([k, v]) => k && v)
          )
        : {};
    return {
      locked: true,
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
      contactIdsOrder: order,
      orderContactIds: order,
      etasByContactId: etas,
      ...(Object.keys(internalFixedStartByContactId).length ? { internalFixedStartByContactId } : {}),
    };
  }

  /** Operationele routevergrendeling na “Bevestig route” (niet hetzelfde als klant-boekings-slot). */
  function normalizeOperationalLock(raw) {
    if (!raw || !raw.locked) return null;
    const order = Array.isArray(raw.orderContactIds) ? raw.orderContactIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const etas = raw.etasByContactId && typeof raw.etasByContactId === 'object' ? raw.etasByContactId : {};
    if (!order.length) return null;
    const internalRaw = raw.internalFixedStartByContactId;
    const internalFixedStartByContactId =
      internalRaw && typeof internalRaw === 'object'
        ? Object.fromEntries(
            Object.entries(internalRaw)
              .map(([k, v]) => [String(k || '').trim(), normalizeInternalFixedPin(v, (x) => x)])
              .filter(([k, v]) => k && v)
          )
        : {};
    return {
      locked: true,
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
      orderContactIds: order,
      etasByContactId: etas,
      ...(Object.keys(internalFixedStartByContactId).length ? { internalFixedStartByContactId } : {}),
    };
  }

  function readStoredRouteLocalDraft(snap, enabled) {
    if (!snap || typeof snap !== 'object') return null;
    if (enabled) return normalizeRouteLocalDraft(snap.routeLocalDraft) || normalizeOperationalLock(snap.routeOperationalLock);
    return normalizeOperationalLock(snap.routeOperationalLock);
  }

  function routeLocalDraftPayloadFromLock(lock) {
    const order = Array.isArray(lock?.contactIdsOrder)
      ? lock.contactIdsOrder
      : Array.isArray(lock?.orderContactIds)
        ? lock.orderContactIds
        : [];
    return {
      savedAt: lock?.savedAt || Date.now(),
      contactIdsOrder: order.map((x) => String(x || '').trim()).filter(Boolean),
      etasByContactId: lock?.etasByContactId && typeof lock.etasByContactId === 'object' ? lock.etasByContactId : {},
      ...(lock?.internalFixedStartByContactId && typeof lock.internalFixedStartByContactId === 'object'
        ? { internalFixedStartByContactId: lock.internalFixedStartByContactId }
        : {}),
    };
  }

  function mergeRouteOrderIntoSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const getContactIdsOrder = input?.getContactIdsOrder;
    const getAppointmentsRef = input?.getAppointmentsRef;
    const normalizeTimeStr = input?.normalizeTimeStr;
    if (!dateStr || !routeSnapshotKey || !getContactIdsOrder || !getAppointmentsRef || !normalizeTimeStr) return;

    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey) || {};
    const enabled = routeRefactorEnabled(input);
    const opLock = readStoredRouteLocalDraft(prev, enabled);
    if (opLock?.locked) return;

    const byContactId = {
      ...(prev.byContactId && typeof prev.byContactId === 'object' ? prev.byContactId : {}),
    };
    const latest = makeByContactId(getAppointmentsRef(), normalizeTimeStr);
    for (const [contactId, payload] of Object.entries(latest)) {
      const merged = { ...(byContactId[contactId] || {}), ...payload };
      if (!payload.internalFixedStartTime) delete merged.internalFixedStartTime;
      byContactId[contactId] = merged;
    }

    try {
      localStorage.setItem(
        snapshotKey,
        JSON.stringify({
          savedAt: Date.now(),
          byContactId,
          contactIdsOrder: getContactIdsOrder() || [],
        })
      );
    } catch (_) {}
  }

  function saveRouteSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const getContactIdsOrder = input?.getContactIdsOrder;
    const getAppointmentsRef = input?.getAppointmentsRef;
    const normalizeTimeStr = input?.normalizeTimeStr;
    if (!dateStr || !routeSnapshotKey || !getContactIdsOrder || !getAppointmentsRef || !normalizeTimeStr) return;

    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey) || {};
    const enabled = routeRefactorEnabled(input);
    const opLock = readStoredRouteLocalDraft(prev, enabled);

    let contactIdsOrder = getContactIdsOrder() || [];
    if (!contactIdsOrder.length) {
      if (prev?.contactIdsOrder?.length) {
        contactIdsOrder = prev.contactIdsOrder;
      }
    }

    try {
      localStorage.setItem(
        snapshotKey,
        JSON.stringify({
          savedAt: Date.now(),
          byContactId: makeByContactId(getAppointmentsRef(), normalizeTimeStr),
          contactIdsOrder,
          ...(opLock
            ? enabled
              ? { routeLocalDraft: routeLocalDraftPayloadFromLock(opLock) }
              : { routeOperationalLock: opLock }
            : {}),
        })
      );
    } catch (_) {}
  }

  /**
   * Sla lokale route-draft op (volgorde + ETA’s) in dezelfde snapshot-sleutel als lokale route.
   */
  function saveRouteLocalDraft(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const normalizeTimeStr = input?.normalizeTimeStr;
    const orderContactIds = input?.orderContactIds;
    const etasByContactId = input?.etasByContactId;
    const internalFixedStartByContactIdIn = input?.internalFixedStartByContactId;
    if (!dateStr || !routeSnapshotKey || !normalizeTimeStr) return;
    const enabled = routeRefactorEnabled(input);

    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey) || {};
    const byContactId = {
      ...(prev.byContactId && typeof prev.byContactId === 'object' ? prev.byContactId : {}),
    };
    const cleanOrder = Array.from(
      new Set((Array.isArray(orderContactIds) ? orderContactIds : []).map((x) => String(x || '').trim()).filter(Boolean))
    );
    const etas = etasByContactId && typeof etasByContactId === 'object' ? etasByContactId : {};
    const hasInternalArg = internalFixedStartByContactIdIn !== undefined && internalFixedStartByContactIdIn !== null;
    const internalFixedStartByContactId =
      hasInternalArg && typeof internalFixedStartByContactIdIn === 'object'
        ? Object.fromEntries(
            Object.entries(internalFixedStartByContactIdIn)
              .map(([k, v]) => [String(k || '').trim(), normalizeInternalFixedPin(v, normalizeTimeStr)])
              .filter(([k, v]) => k && v)
          )
        : null;
    for (const cid of cleanOrder) {
      const t = etas[cid];
      const prevRow = byContactId[cid] && typeof byContactId[cid] === 'object' ? { ...byContactId[cid] } : {};
      if (t) {
        prevRow.timeSlot = normalizeTimeStr(String(t));
        prevRow.estimated = true;
      }
      if (hasInternalArg) {
        const intT = internalFixedStartByContactId ? internalFixedStartByContactId[cid] : undefined;
        if (intT) prevRow.internalFixedStartTime = intT;
        else delete prevRow.internalFixedStartTime;
      }
      if (Object.keys(prevRow).length) byContactId[cid] = prevRow;
    }
    const lock = {
      locked: true,
      savedAt: Date.now(),
      orderContactIds: cleanOrder,
      contactIdsOrder: cleanOrder,
      etasByContactId: Object.fromEntries(
        Object.entries(etas).map(([k, v]) => [String(k), normalizeTimeStr(String(v || ''))]).filter(([, v]) => v)
      ),
      ...(internalFixedStartByContactId && Object.keys(internalFixedStartByContactId).length
        ? { internalFixedStartByContactId }
        : {}),
    };
    try {
      const routeLocalDraft = routeLocalDraftPayloadFromLock(lock);
      localStorage.setItem(
        snapshotKey,
        JSON.stringify({
          savedAt: Date.now(),
          byContactId,
          contactIdsOrder: cleanOrder,
          ...(enabled ? { routeLocalDraft } : { routeOperationalLock: lock }),
        })
      );
    } catch (_) {}
  }

  function saveRouteOperationalLock(input) {
    return saveRouteLocalDraft(input);
  }

  function clearRouteLocalDraft(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return;
    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey);
    if (!prev) return;
    try {
      const next = { ...prev };
      delete next.routeLocalDraft;
      delete next.routeOperationalLock;
      localStorage.setItem(snapshotKey, JSON.stringify(next));
    } catch (_) {}
  }

  function clearRouteOperationalLock(input) {
    return clearRouteLocalDraft(input);
  }

  function isRouteOperationalLocked(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return false;
    const snap = readSnapshot(routeSnapshotKey(dateStr));
    return !!readStoredRouteLocalDraft(snap, routeRefactorEnabled(input))?.locked;
  }

  function readRouteLocalDraft(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return null;
    const snap = readSnapshot(routeSnapshotKey(dateStr));
    return readStoredRouteLocalDraft(snap, routeRefactorEnabled(input));
  }

  function readRouteOperationalLock(input) {
    return readRouteLocalDraft(input);
  }

  function applyRouteSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const getAppointmentsRef = input?.getAppointmentsRef;
    const normalizeTimeStr = input?.normalizeTimeStr;
    const mode =
      input?.mode ||
      window.HKPlannerRouteMode?.resolveRouteStateMode?.({
        routeLockStoreConfigured: input?.routeLockStoreConfigured,
        routeLock: input?.operationalLockOverride || input?.routeLock || null,
        routeRefactorEnabled: routeRefactorEnabled(input),
      }) ||
      'disabled';
    if (!dateStr || !routeSnapshotKey || !getAppointmentsRef || !normalizeTimeStr) {
      return { hasData: false, contactIdsOrder: [], routeOperationalLock: null };
    }

    const snap = readSnapshot(routeSnapshotKey(dateStr));
    const hasSnap = !!snap;
    const opLockOverride = normalizeOperationalLock(input?.operationalLockOverride);
    const allowLooseSnapshot = input?.allowLooseSnapshot !== false && mode !== 'serverConfirmed';
    if (!hasSnap && !opLockOverride) return { hasData: false, contactIdsOrder: [], routeOperationalLock: null };

    const opLock = mode === 'serverConfirmed'
      ? opLockOverride
      : mode === 'localDraft' || mode === 'disabled'
        ? readStoredRouteLocalDraft(snap, routeRefactorEnabled(input))
        : null;

    let appliedCount = 0;
    const byContactId = allowLooseSnapshot ? snap?.byContactId : null;
    if (byContactId && typeof byContactId === 'object') {
      for (const a of getAppointmentsRef() || []) {
        const row = byContactId[a?.contactId];
        if (!row || !a?.contactId) continue;
        const slot = row?.timeSlot ?? row?.time;
        if (slot) {
          a.timeSlot = normalizeTimeStr(String(slot));
          a.estimated = !!row.estimated;
          appliedCount++;
        }
        const rowPin = normalizeInternalFixedPin(row.internalFixedStartTime, normalizeTimeStr);
        if (rowPin) {
          a.internalFixedPin = rowPin;
          a.internalFixedStartTime = rowPin.time;
          appliedCount++;
        } else {
          delete a.internalFixedPin;
          delete a.internalFixedStartTime;
        }
      }
    }

    if (opLock?.locked && opLock.etasByContactId) {
      for (const a of getAppointmentsRef() || []) {
        const cid = a?.contactId ? String(a.contactId) : '';
        if (!cid) continue;
        const t = opLock.etasByContactId[cid];
        if (!t) continue;
        a.timeSlot = normalizeTimeStr(String(t));
        a.estimated = true;
        appliedCount++;
      }
    }

    if (opLock?.locked && opLock.internalFixedStartByContactId) {
      for (const a of getAppointmentsRef() || []) {
        const cid = a?.contactId ? String(a.contactId) : '';
        if (!cid) continue;
        const ft = opLock.internalFixedStartByContactId[cid];
        if (!ft) continue;
        const pin = normalizeInternalFixedPin(ft, normalizeTimeStr);
        if (!pin) continue;
        a.internalFixedPin = pin;
        a.internalFixedStartTime = pin.time;
        appliedCount++;
      }
    }

    const looseOrder = allowLooseSnapshot && Array.isArray(snap?.contactIdsOrder) ? snap.contactIdsOrder : [];
    const contactIdsOrder =
      opLock?.locked && opLock.orderContactIds?.length ? opLock.orderContactIds : looseOrder;

    return {
      hasData: appliedCount > 0 || contactIdsOrder.length > 0 || !!opLock?.locked,
      contactIdsOrder,
      routeOperationalLock: opLock,
      routeLocalDraft: opLock,
      mode,
    };
  }

  function migrateLegacyRouteSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const centralLocked = input?.centralLocked === true;
    if (!dateStr || !routeSnapshotKey || !routeRefactorEnabled(input)) {
      return { migrated: false, hadLegacyOperationalLock: false };
    }
    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey);
    const legacyLock = normalizeOperationalLock(prev?.routeOperationalLock);
    if (!prev || !legacyLock) return { migrated: false, hadLegacyOperationalLock: false };
    try {
      const next = { ...prev };
      delete next.routeOperationalLock;
      if (!centralLocked && !next.routeLocalDraft) {
        next.routeLocalDraft = routeLocalDraftPayloadFromLock(legacyLock);
      }
      localStorage.setItem(snapshotKey, JSON.stringify(next));
    } catch (_) {}
    return { migrated: true, hadLegacyOperationalLock: true };
  }

  window.HKPlannerRouteSnapshot = {
    mergeRouteOrderIntoSnapshot,
    saveRouteSnapshot,
    applyRouteSnapshot,
    saveRouteLocalDraft,
    saveRouteOperationalLock,
    clearRouteLocalDraft,
    clearRouteOperationalLock,
    isRouteOperationalLocked,
    readRouteLocalDraft,
    readRouteOperationalLock,
    migrateLegacyRouteSnapshot,
  };
})();
