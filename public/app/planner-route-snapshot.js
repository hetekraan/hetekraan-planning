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

  function mergeRouteOrderIntoSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const getContactIdsOrder = input?.getContactIdsOrder;
    const getAppointmentsRef = input?.getAppointmentsRef;
    const normalizeTimeStr = input?.normalizeTimeStr;
    if (!dateStr || !routeSnapshotKey || !getContactIdsOrder || !getAppointmentsRef || !normalizeTimeStr) return;

    const snapshotKey = routeSnapshotKey(dateStr);
    const prev = readSnapshot(snapshotKey) || {};
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
    let contactIdsOrder = getContactIdsOrder() || [];
    if (!contactIdsOrder.length) {
      const previous = readSnapshot(snapshotKey);
      if (previous?.contactIdsOrder?.length) {
        contactIdsOrder = previous.contactIdsOrder;
      }
    }

    try {
      localStorage.setItem(
        snapshotKey,
        JSON.stringify({
          savedAt: Date.now(),
          byContactId: makeByContactId(getAppointmentsRef(), normalizeTimeStr),
          contactIdsOrder,
        })
      );
    } catch (_) {}
  }

  function applyRouteSnapshot(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const getAppointmentsRef = input?.getAppointmentsRef;
    const normalizeTimeStr = input?.normalizeTimeStr;
    if (!dateStr || !routeSnapshotKey || !getAppointmentsRef || !normalizeTimeStr) {
      return { hasData: false, contactIdsOrder: [] };
    }

    const snap = readSnapshot(routeSnapshotKey(dateStr));
    if (!snap) return { hasData: false, contactIdsOrder: [] };

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
    const contactIdsOrder = Array.isArray(snap.contactIdsOrder) ? snap.contactIdsOrder : [];
    return { hasData: appliedCount > 0 || contactIdsOrder.length > 0, contactIdsOrder };
  }

  window.HKPlannerRouteSnapshot = {
    mergeRouteOrderIntoSnapshot,
    saveRouteSnapshot,
    applyRouteSnapshot,
  };
})();
