(function () {
  const DEPOT = 'Cornelis Dopperkade, Amsterdam';
  let mapsLoaderPromise = null;
  let map = null;
  let directionsRenderer = null;
  let depotMarkers = [];
  let stopMarkers = [];
  let mapLastErrorCode = '';

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

  function loadGoogleMaps(apiKey) {
    if (window.google?.maps) return Promise.resolve(window.google.maps);
    if (!apiKey) return Promise.reject(new Error('Google Maps key ontbreekt'));
    if (mapsLoaderPromise) return mapsLoaderPromise;
    mapsLoaderPromise = new Promise((resolve, reject) => {
      const cbName = `hkMapsInit_${Date.now()}`;
      window.gm_authFailure = () => {
        mapLastErrorCode = 'GM_AUTH_FAILURE';
        reject(new Error('GM_AUTH_FAILURE'));
      };
      window[cbName] = () => {
        delete window[cbName];
        resolve(window.google.maps);
      };
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${cbName}`;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        mapLastErrorCode = 'SCRIPT_LOAD_FAILED';
        reject(new Error('SCRIPT_LOAD_FAILED'));
      };
      document.head.appendChild(script);
    });
    return mapsLoaderPromise;
  }

  function accentColor() {
    const v = window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return v || '#dc4a1a';
  }

  function clearDepotMarkers() {
    depotMarkers.forEach((m) => m.setMap(null));
    depotMarkers = [];
    stopMarkers.forEach((m) => m.setMap(null));
    stopMarkers = [];
  }

  function buildMapsDirUrl(depotAddress, stops) {
    const waypoints = stops
      .map((a) => String(a?.fullAddressLine || a?.address || '').trim())
      .filter(Boolean)
      .map((x) => encodeURIComponent(x))
      .join('|');
    return (
      `https://www.google.com/maps/dir/?api=1` +
      `&origin=${encodeURIComponent(depotAddress)}` +
      `&destination=${encodeURIComponent(depotAddress)}` +
      (waypoints ? `&waypoints=${waypoints}` : '') +
      `&travelmode=driving`
    );
  }

  function renderMapError(container, code, depotAddress, stops) {
    const safeCode = String(code || 'UNKNOWN_MAP_ERROR');
    const fallback = buildMapsDirUrl(depotAddress, stops);
    container.innerHTML =
      `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;padding:18px;text-align:center">` +
      `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"></circle><path d="M12 7.5v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path><circle cx="12" cy="16.8" r="1" fill="currentColor"></circle></svg>` +
      `<div style="font-weight:600;color:var(--ink)">Kaart niet beschikbaar</div>` +
      `<div style="font-size:12px;color:var(--ink-muted)">${safeCode}</div>` +
      `<a href="${fallback}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 12px;border:1px solid var(--border);border-radius:8px;color:var(--ink);text-decoration:none;background:#fff">Open in Google Maps</a>` +
      `</div>`;
  }

  async function renderRouteMap(input) {
    const container = document.getElementById('routeMap');
    if (!container) return;
    const apiKey = String(input?.apiKey || '').trim();
    const showToast = input?.showToast;
    const depotAddress = String(input?.depotAddress || DEPOT).trim();
    const stops = Array.isArray(input?.stops) ? input.stops : [];
    const ordered = stops.filter((a) => a?.fullAddressLine || a?.address);
    if (!ordered.length) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--ink-muted);font-size:13px">Geen route-adressen</div>';
      return;
    }
    if (!apiKey) {
      mapLastErrorCode = 'MISSING_API_KEY';
      renderMapError(container, mapLastErrorCode, depotAddress, ordered);
      if (typeof showToast === 'function') showToast('Google Maps key ontbreekt', 'info');
      return;
    }
    try {
      await loadGoogleMaps(apiKey);
      if (!map) {
        map = new google.maps.Map(container, {
          zoom: 11,
          center: { lat: 52.3676, lng: 4.9041 },
          mapTypeControl: false,
          streetViewControl: false,
        });
      }
      if (!directionsRenderer) {
        directionsRenderer = new google.maps.DirectionsRenderer({
          suppressMarkers: true,
          polylineOptions: {
            strokeColor: accentColor(),
            strokeWeight: 4,
            strokeOpacity: 0.8,
          },
        });
        directionsRenderer.setMap(map);
      }
      clearDepotMarkers();
      const service = new google.maps.DirectionsService();
      const waypoints = ordered.map((a) => ({
        location: a.fullAddressLine || a.address,
        stopover: true,
      }));
      service.route(
        {
          origin: depotAddress,
          destination: depotAddress,
          travelMode: google.maps.TravelMode.DRIVING,
          waypoints,
          optimizeWaypoints: false,
        },
        (result, status) => {
          if (status !== 'OK' || !result) {
            mapLastErrorCode = `DIRECTIONS_${String(status || 'ERROR')}`;
            renderMapError(container, mapLastErrorCode, depotAddress, ordered);
            if (typeof showToast === 'function') showToast('Routekaart kon niet worden geladen', 'info');
            return;
          }
          directionsRenderer.setDirections(result);
          const legs = result.routes?.[0]?.legs || [];
          const orderedStops = result.routes?.[0]?.waypoint_order || ordered.map((_, i) => i);
          legs.forEach((leg, i) => {
            const stopIdx = orderedStops[i];
            if (stopIdx == null) return;
            stopMarkers.push(new google.maps.Marker({
              position: leg.end_location,
              map,
              label: String(i + 1),
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#111111',
                fillOpacity: 1,
                strokeWeight: 1,
                strokeColor: '#ffffff',
              },
            }));
          });
          if (legs[0]?.start_location) {
            depotMarkers.push(new google.maps.Marker({
              position: legs[0].start_location,
              map,
              label: 'S',
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: accentColor(),
                fillOpacity: 1,
                strokeWeight: 1,
                strokeColor: '#ffffff',
              },
            }));
          }
          if (legs[legs.length - 1]?.end_location) {
            depotMarkers.push(new google.maps.Marker({
              position: legs[legs.length - 1].end_location,
              map,
              label: 'E',
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: accentColor(),
                fillOpacity: 1,
                strokeWeight: 1,
                strokeColor: '#ffffff',
              },
            }));
          }
          const bounds = new google.maps.LatLngBounds();
          result.routes[0].overview_path.forEach((p) => bounds.extend(p));
          map.fitBounds(bounds);
        }
      );
    } catch (err) {
      renderMapError(container, mapLastErrorCode || String(err?.message || 'MAP_LOAD_ERROR'), depotAddress, ordered);
      if (typeof showToast === 'function') showToast(String(err?.message || err || 'Maps fout'), 'info');
    }
  }

  window.HKPlannerRouteMaps = {
    openMaps,
    renderRouteMap,
  };
})();
