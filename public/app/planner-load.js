(function initPlannerLoad(global) {
  async function loadAppointments(ctx, date) {
    const {
      getDateStr,
      refreshGhlContactBaseUrl,
      showToast,
      hkAuthHeader,
      getGhlBaseUrl,
      isKlaarLocally,
      isKlaarLocallyContactDate,
      clearDashBlockedDate,
      applyRouteSnapshot,
      render,
      setAppointments,
      getAppointmentsRef,
    } = ctx;
    const dateStr = getDateStr(date);
    try {
      await refreshGhlContactBaseUrl();
      showToast('⏳ Afspraken laden...', 'loading');
      const res = await fetch(
        `/api/ghl?action=getAppointments&date=${encodeURIComponent(dateStr)}&_=${Date.now()}`,
        { cache: 'no-store', headers: { 'X-HK-Auth': hkAuthHeader() } }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAppointments([]);
        showToast(data?.error ? String(data.error) : `Afspraken laden mislukt (${res.status})`, 'info');
        applyRouteSnapshot(dateStr);
        render();
        return;
      }
      const rows = Array.isArray(data?.appointments) ? data.appointments : [];
      setAppointments(
        rows.map((a) => ({
          ...a,
          ghlUrl: a.contactId ? `${getGhlBaseUrl()}/${a.contactId}` : '',
          review: false,
          priceVisible: false,
        }))
      );
      const appts = getAppointmentsRef();
      appts.forEach((a) => {
        if (a.id && isKlaarLocally(a.id)) a.status = 'klaar';
        if (a.contactId && isKlaarLocallyContactDate(a.contactId, dateStr)) a.status = 'klaar';
      });
      const nBlk = appts.filter((a) => a.isCalBlock).length;
      const nCli = appts.length - nBlk;
      if (nBlk > 0) clearDashBlockedDate(dateStr);
      if (appts.length === 0) {
        showToast('Geen afspraken voor deze dag', 'info');
      } else {
        const parts = [];
        if (nCli) parts.push(`${nCli} afspraak${nCli === 1 ? '' : 'en'}`);
        if (nBlk) parts.push(`${nBlk} blokslot${nBlk === 1 ? '' : 'ten'}`);
        showToast(`✓ ${parts.join(', ')} geladen`, 'success');
      }
    } catch (err) {
      console.warn('GHL niet bereikbaar', err);
      setAppointments([]);
      showToast('Kon afspraken niet laden', 'info');
    }
    applyRouteSnapshot(dateStr);
    render();
  }

  global.HKPlannerLoad = { loadAppointments };
})(window);
