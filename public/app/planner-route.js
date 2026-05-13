(function initPlannerRoute(global) {
  let saveRouteTimesMutationInFlight = false;

  function isRouteLockRevisionConflict(status, data) {
    if (Number(status) !== 409) return false;
    const code = String(data?.code || '').trim();
    return (
      code === 'EXPECTED_REVISION_REQUIRED' ||
      code === 'REVISION_CONFLICT' ||
      code === 'ROUTE_LOCK_EXPECTED_REVISION_REQUIRED' ||
      code === 'ROUTE_LOCK_REVISION_CONFLICT'
    );
  }

  function timeToWindow(timeStr, isFirst) {
    if (isFirst || timeStr === '08:00' || timeStr === '09:00') return timeStr;
    const [h, m] = String(timeStr || '08:00').split(':').map(Number);
    const totalMin = (Number.isFinite(h) ? h : 8) * 60 + (Number.isFinite(m) ? m : 0);
    const fmt = (min) => {
      const hh = Math.max(0, Math.floor(min / 60));
      const mm = min % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm < 0 ? 0 : mm).padStart(2, '0')}`;
    };
    return `${fmt(totalMin - 60)}-${fmt(totalMin + 60)}`;
  }

  async function sendETA(ctx, appt) {
    if (!appt?.contactId) return { ok: false, error: 'Geen GHL contactId' };
    try {
      const res = await fetch('/api/ghl?action=sendETA', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({
          contactId: appt.contactId,
          eta: appt.timeSlot,
          name: appt.name,
        }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch {}
      if (!res.ok) {
        const msg = data.error || data.message || `Serverfout (${res.status})`;
        return { ok: false, error: msg, workflowTag: data.workflowTag };
      }
      return { ok: true, workflowTag: data.workflowTag };
    } catch (e) {
      return { ok: false, error: e.message || 'Netwerkfout' };
    }
  }

  async function sendMorningMessages(ctx) {
    const appts = ctx
      .getAppointmentsRef()
      .filter((a) => a.contactId && a.status === 'ingepland')
      .map((a) => ({ contactId: a.contactId, timeFrom: a.timeSlot, timeTo: a.timeSlot }));
    if (appts.length === 0) {
      ctx.showToast('Geen ingeplande klanten om te melden', 'info');
      return;
    }
    ctx.showToast('☀️ Ochtendmeldingen worden verstuurd...', 'loading');
    try {
      const res = await fetch('/api/ghl?action=sendMorningMessages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({ appointments: appts }),
      });
      if (res.ok) ctx.showToast(`☀️ Verstuurd naar ${appts.length} klant${appts.length !== 1 ? 'en' : ''}`, 'success');
      else {
        const d = await res.json().catch(() => ({}));
        ctx.showToast(`⚠ Ochtendmeldingen mislukt: ${d.error || res.status}`, 'info');
      }
    } catch {
      ctx.showToast('⚠ Ochtendmeldingen niet verstuurd: geen verbinding', 'info');
    }
  }

  async function confirmRoute(ctx) {
    const routeDate = ctx.getDateStr(ctx.getCurrentDate());
    if (typeof ctx.isRouteOperationalLocked === 'function' && ctx.isRouteOperationalLocked(routeDate)) {
      ctx.showToast('Route is al vergrendeld voor deze dag. Ontgrendel eerst om opnieuw te bevestigen.', 'info');
      return;
    }
    const active = ctx
      .getAppointmentsRef()
      .filter((a) => a.contactId && a.timeSlot && a.status !== 'klaar');
    const routeSequence = [...active].sort((a, b) => (a.routeStop || 99) - (b.routeStop || 99));
    const toSave = routeSequence.map((a, i) => ({
      contactId: a.contactId,
      plannedTime: timeToWindow(a.timeSlot, i === 0),
      ghlAppointmentId: a.id || undefined,
      routeDate,
      startTime: a.timeSlot,
      durationMin: ctx.jobDurationForType(a.jobType),
    }));
    if (toSave.length === 0) {
      ctx.showToast('Geen afspraken met GHL contactId om op te slaan', 'info');
      return;
    }
    const btn = document.getElementById('btnConfirmRoute');
    if (btn) {
      btn.textContent = '⏳ Opslaan...';
      btn.disabled = true;
    }
    try {
      const plannerUser = typeof ctx.getCurrentPlannerUser === 'function' ? ctx.getCurrentPlannerUser() : '';
      const orderContactIds = routeSequence.map((a) => (a?.contactId ? String(a.contactId) : '')).filter(Boolean);
      const etasByContactId = {};
      routeSequence.forEach((a) => {
        const cid = a?.contactId ? String(a.contactId) : '';
        const ts = a?.timeSlot ? ctx.normalizeTimeStr(String(a.timeSlot).replace(/^~/, '')) : '';
        if (cid && ts) etasByContactId[cid] = ts;
      });
      const internalFixedStartByContactId = {};
      routeSequence.forEach((a) => {
        const cid = a?.contactId ? String(a.contactId) : '';
        const pinObj =
          a?.internalFixedPin && typeof a.internalFixedPin === 'object'
            ? {
                type: String(a.internalFixedPin.type || '').trim().toLowerCase() || 'exact',
                time: ctx.normalizeTimeStr(String(a.internalFixedPin.time || '').replace(/^~/, '')),
              }
            : null;
        const legacyTime = a?.internalFixedStartTime
          ? ctx.normalizeTimeStr(String(a.internalFixedStartTime).replace(/^~/, ''))
          : '';
        if (cid && pinObj && /^(exact|after|before)$/.test(pinObj.type) && /^\d{2}:\d{2}$/.test(pinObj.time)) {
          internalFixedStartByContactId[cid] = pinObj;
        } else if (cid && legacyTime) {
          internalFixedStartByContactId[cid] = { type: 'exact', time: legacyTime };
        }
      });
      saveRouteTimesMutationInFlight = true;
      try {
        const buildRouteLockPayload = (expectedRevision) => ({
          dateStr: routeDate,
          locked: true,
          orderContactIds,
          etasByContactId,
          internalFixedStartByContactId,
          updatedBy: plannerUser || 'unknown',
          expectedRevision,
        });
        const postSaveRouteTimes = async (expectedRevision) => {
          const res = await fetch('/api/ghl?action=saveRouteTimes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
            body: JSON.stringify({
              routeTimes: toSave,
              routeLock: buildRouteLockPayload(expectedRevision),
            }),
          });
          const data = await res.json().catch(() => ({}));
          return { res, data };
        };
        const currentRevision =
          typeof ctx.getRouteLockRevisionForDate === 'function'
            ? ctx.getRouteLockRevisionForDate(routeDate)
            : 0;
        let { res, data } = await postSaveRouteTimes(currentRevision);
        if (!res.ok && isRouteLockRevisionConflict(res.status, data)) {
          if (typeof ctx.loadAppointments === 'function') {
            await ctx.loadAppointments(ctx.getCurrentDate(), { plannerLoadQuiet: true });
          }
          const refreshedRevision =
            typeof ctx.getRouteLockRevisionForDate === 'function'
              ? ctx.getRouteLockRevisionForDate(routeDate)
              : currentRevision;
          ({ res, data } = await postSaveRouteTimes(refreshedRevision));
          if (!res.ok && isRouteLockRevisionConflict(res.status, data)) {
            ctx.showToast('Route is door iemand anders aangepast, ververs de pagina', 'info');
            return;
          }
        }
        if (!res.ok) throw new Error(data.error || 'Fout');
        if (btn) {
          btn.textContent = '✓ Opgeslagen';
          btn.classList.add('saved');
        }
        let msg = `✓ ${data.saved} klanten: geplande aankomst opgeslagen`;
        if (data.calendarSynced > 0) {
          msg += ` · ${data.calendarSynced} afspraak${data.calendarSynced > 1 ? 'en' : ''} in GHL-agenda bijgewerkt`;
        }
        if (data.calendarErrors?.length) msg += ` · ⚠️ ${data.calendarErrors.length} agenda-update mislukt (zie serverlog)`;
        ctx.showToast(msg, 'success');
        if (typeof ctx.isRouteRefactorEnabled === 'function' && ctx.isRouteRefactorEnabled() === false) {
          const saveDraftOrder = ctx.setLocalDraftRouteOrder || ctx.setConfirmedRouteOrder;
          if (typeof saveDraftOrder === 'function') {
            saveDraftOrder(routeDate, orderContactIds);
          }
          const saveDraft = ctx.saveRouteLocalDraft || ctx.saveRouteOperationalLock;
          if (typeof saveDraft === 'function') {
            saveDraft(routeDate, {
              orderContactIds,
              etasByContactId,
              internalFixedStartByContactId,
            });
          }
          ctx.saveRouteSnapshot(routeDate);
        } else if (typeof ctx.syncCentralRouteLock === 'function' && data.routeLock) {
          ctx.syncCentralRouteLock(routeDate, data.routeLock, true);
        }
        if (typeof ctx.logRouteOrder === 'function') {
          ctx.logRouteOrder('route_order_confirmed', {
            routeDate,
            sourceOfTruth: 'server_route_lock',
            appointmentIds: routeSequence.map((a) => (a?.id != null ? String(a.id) : '')).filter(Boolean),
            confirmedOrderIds: orderContactIds,
            loadedOrderIds: orderContactIds,
          });
        }
        if (typeof ctx.render === 'function') {
          ctx.render();
        }
        if (typeof ctx.loadAppointments === 'function') {
          await ctx.loadAppointments(ctx.getCurrentDate(), { plannerLoadQuiet: true });
        }
      } finally {
        saveRouteTimesMutationInFlight = false;
      }
      if (btn) {
        setTimeout(() => {
          btn.textContent = '✓ Bevestig route';
          btn.classList.remove('saved');
          btn.disabled = false;
        }, 3000);
      }
    } catch (e) {
      if (btn) {
        btn.textContent = '✓ Bevestig route';
        btn.disabled = false;
      }
      ctx.showToast('Opslaan mislukt: ' + e.message, 'info');
    }
  }

  global.HKPlannerRoute = {
    sendETA,
    sendMorningMessages,
    confirmRoute,
    isSaveRouteMutationInFlight: () => saveRouteTimesMutationInFlight,
  };
})(window);
