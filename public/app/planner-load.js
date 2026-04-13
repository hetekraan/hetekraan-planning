(function initPlannerLoad(global) {
  let loadSeq = 0;

  function shouldDebugDateNav() {
    try {
      return localStorage.getItem('hk_debug_date_nav') === '1';
    } catch (_) {
      return false;
    }
  }

  function debugDateNav(tag, payload) {
    if (!shouldDebugDateNav()) return;
    try {
      console.info(`[DATE_NAV][${tag}]`, payload || {});
    } catch (_) {}
  }

  async function loadAppointments(ctx, date) {
    const {
      getDateStr,
      refreshGhlContactBaseUrl,
      showToast,
      hkAuthHeader,
      getGhlBaseUrl,
      getGhlIosContactAppUrlTemplate,
      isKlaarLocally,
      isKlaarLocallyContactDate,
      clearDashBlockedDate,
      syncCentralRouteLock,
      applyRouteSnapshot,
      render,
      setAppointments,
      getAppointmentsRef,
    } = ctx;
    const dateStr = getDateStr(date);
    const reqId = ++loadSeq;
    debugDateNav('load_start', { reqId, dateStr });
    try {
      await refreshGhlContactBaseUrl();
      showToast('⏳ Afspraken laden...', 'loading');
      const res = await fetch(
        `/api/ghl?action=getAppointments&date=${encodeURIComponent(dateStr)}&_=${Date.now()}`,
        { cache: 'no-store', headers: { 'X-HK-Auth': hkAuthHeader() } }
      );
      const data = await res.json().catch(() => ({}));
      if (reqId !== loadSeq) {
        debugDateNav('ignored_stale_response', { reqId, dateStr, status: res.status });
        return;
      }
      if (!res.ok) {
        setAppointments([]);
        if (typeof ctx.setPlannerCustomerDayFull === 'function') {
          ctx.setPlannerCustomerDayFull(false, false);
        }
        showToast(data?.error ? String(data.error) : `Afspraken laden mislukt (${res.status})`, 'info');
        applyRouteSnapshot(dateStr);
        render();
        debugDateNav('load_finish', { reqId, dateStr, ok: false, status: res.status });
        return;
      }
      const rows = Array.isArray(data?.appointments) ? data.appointments : [];
      if (typeof ctx.setPlannerCustomerDayFull === 'function') {
        ctx.setPlannerCustomerDayFull(!!data.customerDayFull, !!data.customerDayFullStoreConfigured);
      }
      if (typeof syncCentralRouteLock === 'function') {
        syncCentralRouteLock(dateStr, data.routeLock || null, !!data.routeLockStoreConfigured);
      }
      const appTpl = typeof getGhlIosContactAppUrlTemplate === 'function' ? getGhlIosContactAppUrlTemplate() : '';
      setAppointments(
        rows.map((a) => {
          const web = a.contactId && getGhlBaseUrl() ? `${getGhlBaseUrl()}/${a.contactId}` : '';
          const app =
            appTpl && a.contactId
              ? String(appTpl).split('{contactId}').join(encodeURIComponent(String(a.contactId)))
              : '';
          return {
            ...a,
            ghlUrl: web,
            ghlAppUrl: app,
            review: false,
            priceVisible: false,
          };
        })
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
      debugDateNav('load_finish', { reqId, dateStr, ok: true, count: appts.length });
    } catch (err) {
      if (reqId !== loadSeq) {
        debugDateNav('ignored_stale_response', { reqId, dateStr, reason: 'catch' });
        return;
      }
      console.warn('GHL niet bereikbaar', err);
      setAppointments([]);
      if (typeof ctx.setPlannerCustomerDayFull === 'function') {
        ctx.setPlannerCustomerDayFull(false, false);
      }
      showToast('Kon afspraken niet laden', 'info');
      debugDateNav('load_finish', { reqId, dateStr, ok: false, reason: 'exception' });
    }
    if (reqId !== loadSeq) {
      debugDateNav('ignored_stale_response', { reqId, dateStr, reason: 'post_processing' });
      return;
    }
    applyRouteSnapshot(dateStr);
    render();
  }

  global.HKPlannerLoad = { loadAppointments };
})(window);
