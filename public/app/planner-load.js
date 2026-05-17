(function initPlannerLoad(global) {
  let loadSeq = 0;
  let loadAppointmentsInflight = 0;

  function shouldDebugDateNav() {
    try {
      return localStorage.getItem('hk_debug_date_nav') === '1';
    } catch (_) {
      return false;
    }
  }

  function hkDbgStatusSync() {
    try {
      return localStorage.getItem('hk_debug_status_sync') === '1';
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
    loadAppointmentsInflight++;
    try {
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
        syncLiveRouteState,
        applyRouteSnapshot,
        render,
        setAppointments,
        getAppointmentsRef,
      } = ctx;
      const dateStr = getDateStr(date);
      const reqId = ++loadSeq;
      const quietLoad = ctx.plannerLoadQuiet === true;
      const fetchT0 = Date.now();
      debugDateNav('load_start', { reqId, dateStr, quiet: quietLoad });
      try {
        await refreshGhlContactBaseUrl();
        if (!quietLoad) showToast('⏳ Afspraken laden...', 'loading');
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
          if (!quietLoad) {
            showToast(data?.error ? String(data.error) : `Afspraken laden mislukt (${res.status})`, 'info');
          }
          applyRouteSnapshot(dateStr);
          render();
          debugDateNav('load_finish', { reqId, dateStr, ok: false, status: res.status });
          return;
        }
        const rows = Array.isArray(data?.appointments) ? data.appointments : [];
        const fetchTimestamp = Date.now();
        const serverById = new Map();
        for (const r of rows) {
          const sid = r?.id != null ? String(r.id) : '';
          if (sid) {
            serverById.set(sid, {
              serverStatus: String(r.status || ''),
              datumOnderhoud: r.datumOnderhoud != null ? String(r.datumOnderhoud) : '',
              paymentStatus: r.paymentStatus != null ? String(r.paymentStatus) : '',
            });
          }
        }
        try {
          let extraLinesTotal = 0;
          let clientsWithExtras = 0;
          for (const row of rows) {
            const n = Array.isArray(row?.extras) ? row.extras.length : 0;
            if (n > 0) {
              clientsWithExtras += 1;
              extraLinesTotal += n;
            }
          }
          console.info(
            '[planner] price_lines_loaded',
            JSON.stringify({
              serviceDay: dateStr,
              appointmentsCount: rows.length,
              clientsWithExtras,
              extraLinesTotal,
            })
          );
        } catch (_) {}
        if (typeof ctx.setPlannerCustomerDayFull === 'function') {
          ctx.setPlannerCustomerDayFull(!!data.customerDayFull, !!data.customerDayFullStoreConfigured);
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
        if (typeof syncLiveRouteState === 'function') {
          syncLiveRouteState(dateStr, data.routeState || null);
        }
        const appts = getAppointmentsRef();
        appts.forEach((a) => {
          if (!a || a.isCalBlock) return;
          const aid = a.id != null ? String(a.id) : '';
          const srv = aid ? serverById.get(aid) : null;
          const serverStatusVal = srv ? srv.serverStatus : String(a.status || '');
          const lsId = !!(a.id && isKlaarLocally(a.id));
          const lsCid = !!(a.contactId && isKlaarLocallyContactDate(a.contactId, dateStr));
          if ((lsId || lsCid) && serverStatusVal !== 'klaar') {
            console.warn(
              '[planner] hk_klaar_localStorage_ignored_server_not_klaar',
              JSON.stringify({
                appointmentId: aid,
                contactId: a.contactId || null,
                routeDate: dateStr,
                serverStatus: serverStatusVal,
                localStorageHasKlaarId: lsId,
                localStorageHasKlaarContactDate: lsCid,
              })
            );
          }
        });
        const nKlaar = appts.filter((x) => x.status === 'klaar').length;
        console.info(
          '[planner] completion_state_loaded',
          JSON.stringify({
            serviceDay: dateStr,
            total: appts.length,
            klaarCount: nKlaar,
            sourceOfTruth: 'server_getAppointments_only_status_not_from_localStorage',
          })
        );
        if (hkDbgStatusSync()) {
          const dbgMeta =
            typeof ctx.getPlannerDebugMeta === 'function' ? ctx.getPlannerDebugMeta() || {} : {};
          const cards = appts
            .filter((x) => !x.isCalBlock)
            .slice(0, 48)
            .map((a) => {
              const aid = a?.id != null ? String(a.id) : '';
              const srv = aid ? serverById.get(aid) : null;
              const statusBeforeLocalRepair = srv ? srv.serverStatus : String(a.status || '');
              const lsId = !!(a.id && isKlaarLocally(a.id));
              const lsCid = !!(a.contactId && isKlaarLocallyContactDate(a.contactId, dateStr));
              const serverStatusVal = srv ? srv.serverStatus : String(a.status || '');
              return {
                appointmentId: aid,
                contactId: a.contactId || null,
                viewedRouteDateStr: dateStr,
                serverStatus: serverStatusVal,
                statusBeforeLocalRepair,
                datumOnderhoud: srv ? srv.datumOnderhoud : (a.datumOnderhoud != null ? String(a.datumOnderhoud) : ''),
                paymentStatus: srv ? srv.paymentStatus : (a.paymentStatus != null ? String(a.paymentStatus) : ''),
                localStorageHasKlaarId: lsId,
                localStorageHasKlaarContactDate: lsCid,
                statusAfterLocalRepair: String(a.status || ''),
                fetchTimestamp,
                fetchElapsedMs: fetchTimestamp - fetchT0,
                plannerDataVersion: dbgMeta.remoteAppVersion != null ? String(dbgMeta.remoteAppVersion) : '',
                docVisibility: dbgMeta.visibilityState != null ? String(dbgMeta.visibilityState) : '',
              };
            });
          console.info(
            'PLANNER_APPOINTMENT_STATUS',
            JSON.stringify({
              phase: 'client_fetch_reconciled',
              routeDate: dateStr,
              reqId,
              cards,
            })
          );
          appts.forEach((a) => {
            if (!a || a.isCalBlock) return;
            const aid = a.id != null ? String(a.id) : '';
            const srv = aid ? serverById.get(aid) : null;
            const st = srv ? srv.serverStatus : String(a.status || '');
            a._hkDbgSync = {
              serverStatus: st,
              statusAfterLocalRepair: String(a.status || ''),
            };
          });
        }
        console.info(
          '[planner] completion_state_source',
          JSON.stringify({
            primary: 'GHL_datum_laatste_onderhoud_and_betaal_fields_mapped_serverSide',
            clientOverlay: 'hk_klaar_ids_legacy_only_warn_if_mismatch_not_used_for_status',
          })
        );
        const nBlk = appts.filter((a) => a.isCalBlock).length;
        const nCli = appts.length - nBlk;
        if (nBlk > 0) clearDashBlockedDate(dateStr);
        if (appts.length === 0) {
          if (!quietLoad) showToast('Geen afspraken voor deze dag', 'info');
        } else {
          const parts = [];
          if (nCli) parts.push(`${nCli} afspraak${nCli === 1 ? '' : 'en'}`);
          if (nBlk) parts.push(`${nBlk} blokslot${nBlk === 1 ? '' : 'ten'}`);
          if (!quietLoad) showToast(`✓ ${parts.join(', ')} geladen`, 'success');
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
        if (!quietLoad) showToast('Kon afspraken niet laden', 'info');
        debugDateNav('load_finish', { reqId, dateStr, ok: false, reason: 'exception' });
      }
      if (reqId !== loadSeq) {
        debugDateNav('ignored_stale_response', { reqId, dateStr, reason: 'post_processing' });
        return;
      }
      applyRouteSnapshot(dateStr);
      const preserveScroll = ctx.plannerPreserveScroll === true;
      const panel = document.getElementById('panelAfspraken');
      const savedPanelScrollTop = preserveScroll && panel ? panel.scrollTop : null;
      const savedWindowScrollY =
        preserveScroll && typeof window !== 'undefined' ? window.scrollY : null;
      render();
      if (preserveScroll) {
        if (panel && savedPanelScrollTop != null) {
          panel.scrollTop = savedPanelScrollTop;
        }
        if (typeof window !== 'undefined' && savedWindowScrollY != null) {
          window.scrollTo(0, savedWindowScrollY);
        }
      }
    } finally {
      loadAppointmentsInflight = Math.max(0, loadAppointmentsInflight - 1);
    }
  }

  global.HKPlannerLoad = {
    loadAppointments,
    getLoadAppointmentsInflight: () => loadAppointmentsInflight,
  };
})(window);
