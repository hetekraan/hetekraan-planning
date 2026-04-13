(function () {
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
      if (!a?.contactId || !a?.timeSlot) continue;
      byContactId[a.contactId] = {
        timeSlot: normalizeTimeStr(a.timeSlot),
        estimated: !!a.estimated,
      };
    }
    return byContactId;
  }

  /** Operationele routevergrendeling na “Bevestig route” (niet hetzelfde als klant-boekings-slot). */
  function normalizeOperationalLock(raw) {
    if (!raw || !raw.locked) return null;
    const order = Array.isArray(raw.orderContactIds) ? raw.orderContactIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const etas = raw.etasByContactId && typeof raw.etasByContactId === 'object' ? raw.etasByContactId : {};
    if (!order.length) return null;
    return {
      locked: true,
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
      orderContactIds: order,
      etasByContactId: etas,
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
    const opLock = normalizeOperationalLock(prev.routeOperationalLock);
    if (opLock?.locked) return;

    const byContactId = {
      ...(prev.byContactId && typeof prev.byContactId === 'object' ? prev.byContactId : {}),
    };
    const latest = makeByContactId(getAppointmentsRef(), normalizeTimeStr);
    for (const [contactId, payload] of Object.entries(latest)) byContactId[contactId] = payload;

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
    const opLock = normalizeOperationalLock(prev.routeOperationalLock);

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
          ...(opLock ? { routeOperationalLock: opLock } : {}),
        })
      );
    } catch (_) {}
  }

  /**
   * Sla harde route-lock op (volgorde + ETA’s) in dezelfde snapshot-sleutel als lokale route.
   */
  function saveRouteOperationalLock(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const normalizeTimeStr = input?.normalizeTimeStr;
    const orderContactIds = input?.orderContactIds;
    const etasByContactId = input?.etasByContactId;
    if (!dateStr || !routeSnapshotKey || !normalizeTimeStr) return;

    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey) || {};
    const byContactId = {
      ...(prev.byContactId && typeof prev.byContactId === 'object' ? prev.byContactId : {}),
    };
    const cleanOrder = Array.from(
      new Set((Array.isArray(orderContactIds) ? orderContactIds : []).map((x) => String(x || '').trim()).filter(Boolean))
    );
    const etas = etasByContactId && typeof etasByContactId === 'object' ? etasByContactId : {};
    for (const cid of cleanOrder) {
      const t = etas[cid];
      if (t) {
        byContactId[cid] = {
          timeSlot: normalizeTimeStr(String(t)),
          estimated: true,
        };
      }
    }
    const lock = {
      locked: true,
      savedAt: Date.now(),
      orderContactIds: cleanOrder,
      etasByContactId: Object.fromEntries(
        Object.entries(etas).map(([k, v]) => [String(k), normalizeTimeStr(String(v || ''))]).filter(([, v]) => v)
      ),
    };
    try {
      localStorage.setItem(
        snapshotKey,
        JSON.stringify({
          savedAt: Date.now(),
          byContactId,
          contactIdsOrder: cleanOrder,
          routeOperationalLock: lock,
        })
      );
    } catch (_) {}
  }

  function clearRouteOperationalLock(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return;
    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey);
    if (!prev) return;
    try {
      const next = { ...prev };
      delete next.routeOperationalLock;
      localStorage.setItem(snapshotKey, JSON.stringify(next));
    } catch (_) {}
  }

  function isRouteOperationalLocked(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return false;
    const snap = readSnapshot(routeSnapshotKey(dateStr));
    return !!normalizeOperationalLock(snap?.routeOperationalLock)?.locked;
  }

  function readRouteOperationalLock(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return null;
    const snap = readSnapshot(routeSnapshotKey(dateStr));
    return normalizeOperationalLock(snap?.routeOperationalLock);
  }

  function applyRouteSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const getAppointmentsRef = input?.getAppointmentsRef;
    const normalizeTimeStr = input?.normalizeTimeStr;
    if (!dateStr || !routeSnapshotKey || !getAppointmentsRef || !normalizeTimeStr) {
      return { hasData: false, contactIdsOrder: [], routeOperationalLock: null };
    }

    const snap = readSnapshot(routeSnapshotKey(dateStr));
    if (!snap) return { hasData: false, contactIdsOrder: [], routeOperationalLock: null };

    const opLock = normalizeOperationalLock(snap.routeOperationalLock);

    let appliedCount = 0;
    const byContactId = snap.byContactId;
    if (byContactId && typeof byContactId === 'object') {
      for (const a of getAppointmentsRef() || []) {
        const row = byContactId[a?.contactId];
        const slot = row?.timeSlot ?? row?.time;
        if (!slot || !a?.contactId) continue;
        a.timeSlot = normalizeTimeStr(slot);
        a.estimated = !!row.estimated;
        appliedCount++;
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

    const looseOrder = Array.isArray(snap.contactIdsOrder) ? snap.contactIdsOrder : [];
    const contactIdsOrder =
      opLock?.locked && opLock.orderContactIds?.length ? opLock.orderContactIds : looseOrder;

    return {
      hasData: appliedCount > 0 || contactIdsOrder.length > 0 || !!opLock?.locked,
      contactIdsOrder,
      routeOperationalLock: opLock,
    };
  }

  window.HKPlannerRouteSnapshot = {
    mergeRouteOrderIntoSnapshot,
    saveRouteSnapshot,
    applyRouteSnapshot,
    saveRouteOperationalLock,
    clearRouteOperationalLock,
    isRouteOperationalLocked,
    readRouteOperationalLock,
  };
})();
