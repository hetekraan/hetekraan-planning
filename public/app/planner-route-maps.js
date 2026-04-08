(function () {
  const DEPOT = 'Cornelis Dopperkade, Amsterdam';

  function openMaps(event, input) {
    if (event?.preventDefault) event.preventDefault();
    const appointments = Array.isArray(input?.appointments) ? input.appointments : [];
    const showToast = input?.showToast;

    const sorted = appointments
      .filter((a) => a?.status !== 'klaar' && (a?.fullAddressLine || a?.address))
      .sort((a, b) => (a?.routeStop || 99) - (b?.routeStop || 99));

    if (!sorted.length) {
      if (typeof showToast === 'function') showToast('Geen adressen beschikbaar', 'info');
      return;
    }

    const waypoints = sorted.map((a) => encodeURIComponent(a.fullAddressLine || a.address)).join('|');
    const url =
      `https://www.google.com/maps/dir/?api=1` +
      `&origin=${encodeURIComponent(DEPOT)}` +
      `&destination=${encodeURIComponent(DEPOT)}` +
      `&waypoints=${waypoints}` +
      `&travelmode=driving`;

    window.open(url, '_blank');
  }

  window.HKPlannerRouteMaps = {
    openMaps,
  };
})();
