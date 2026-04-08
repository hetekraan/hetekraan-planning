(function () {
  function readSnapshotOrder(snapshotKey) {
    try {
      const raw = localStorage.getItem(snapshotKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.contactIdsOrder) ? parsed.contactIdsOrder : [];
    } catch (_) {
      return [];
    }
  }

  function getRouteStopsForSidebar(input) {
    const appointments = Array.isArray(input?.appointments) ? input.appointments : [];
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return [];

    const active = appointments.filter((a) => a?.fullAddressLine && a?.status !== 'klaar');
    const orderIds = readSnapshotOrder(routeSnapshotKey(dateStr));
    if (!orderIds.length) {
      return [...active].sort(
        (a, b) =>
          (a?.dayPart ?? 0) - (b?.dayPart ?? 0) ||
          (a?.startMs ?? 0) - (b?.startMs ?? 0) ||
          String(a?.timeSlot || '').localeCompare(String(b?.timeSlot || ''))
      );
    }

    const byContact = Object.fromEntries(active.filter((a) => a?.contactId).map((a) => [a.contactId, a]));
    const used = new Set();
    const ordered = [];
    for (const contactId of orderIds) {
      if (byContact[contactId] && !used.has(contactId)) {
        ordered.push(byContact[contactId]);
        used.add(contactId);
      }
    }
    for (const a of active) {
      if (!a?.contactId || !used.has(a.contactId)) {
        if (!ordered.includes(a)) ordered.push(a);
        if (a?.contactId) used.add(a.contactId);
      }
    }
    return ordered;
  }

  function updateRouteLocalUi(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    if (!dateStr || !routeSnapshotKey) return;

    let hasLocalSnapshot = false;
    try {
      hasLocalSnapshot = !!localStorage.getItem(routeSnapshotKey(dateStr));
    } catch (_) {}

    const hint = document.getElementById('routeLocalHint');
    const resetButton = document.getElementById('btnResetLocalRoute');

    if (hint) {
      if (hasLocalSnapshot) {
        hint.style.display = 'block';
        hint.textContent =
          'ℹ️ Lokale route (volgorde + tijden) actief — blijft zo na verversen of andere dag, tot je opnieuw bevestigt of hieronder reset.';
      } else {
        hint.style.display = 'none';
        hint.textContent = '';
      }
    }
    if (resetButton) resetButton.style.display = hasLocalSnapshot ? 'block' : 'none';
  }

  async function resetLocalRouteTimes(input) {
    const dateStr = input?.dateStr;
    const routeSnapshotKey = input?.routeSnapshotKey;
    const updateRouteLocalUiFn = input?.updateRouteLocalUi;
    const reload = input?.reload;
    const showToast = input?.showToast;
    if (!dateStr || !routeSnapshotKey || !updateRouteLocalUiFn || !reload || !showToast) return;

    try {
      localStorage.removeItem(routeSnapshotKey(dateStr));
    } catch (_) {}
    updateRouteLocalUiFn();
    await reload();
    showToast('Lokale tijden gewist — opnieuw uit GHL geladen', 'success');
  }

  window.HKPlannerRouteLocalUi = {
    getRouteStopsForSidebar,
    updateRouteLocalUi,
    resetLocalRouteTimes,
  };
})();
