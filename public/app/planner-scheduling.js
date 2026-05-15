(function initPlannerScheduling(global) {
  /**
   * Route-optimalisatie via `/api/optimize-route` met `mode: "partitionedDay"`:
   * depot → ochtend (09:00–13:00, eerste stop 09:00) → overgang laatste ochtend → middag (≥13:00, 13:00–17:00)
   * → optioneel reistijd terug naar depot in API-response.
   */
  async function optimizeRoute(ctx) {
    const dateStr = ctx.getDateStr(ctx.getCurrentDate());
    const routeState = typeof ctx.getLiveRouteState === 'function' ? ctx.getLiveRouteState(dateStr) : null;
    if (!routeState) {
      ctx.showToast('Live route wordt nog geladen. Probeer zo opnieuw.', 'info');
      return;
    }
    if (typeof ctx.setRouteUiStatus === 'function') ctx.setRouteUiStatus(dateStr, { optimizing: true, slow: false });
    ctx.showToast('⏳ Live route wordt bijgewerkt...', 'loading');
    try {
      const res = await fetch('/api/route/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({
          locationId:
            routeState.locationId ||
            (typeof ctx.getPlannerLocationId === 'function' ? ctx.getPlannerLocationId() : ''),
          dateStr,
          expectedRevision: Number(routeState.revision) || 0,
          updatedBy: typeof ctx.getCurrentPlannerUser === 'function' ? ctx.getCurrentPlannerUser() : '',
          reason: 'manual_button',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !data.routeState) {
        throw new Error(data?.code || data?.error || `Optimaliseren mislukt (${res.status})`);
      }
      if (typeof ctx.setLiveRouteState === 'function') ctx.setLiveRouteState(dateStr, data.routeState);
      if (typeof ctx.applyRouteSnapshot === 'function') ctx.applyRouteSnapshot(dateStr);
      if (typeof ctx.scheduleRouteRevisionFollowupRefresh === 'function') ctx.scheduleRouteRevisionFollowupRefresh(dateStr);
      ctx.showToast('Live route bijgewerkt', 'success');
      ctx.render();
    } catch (e) {
      console.error('Heroptimaliseren mislukt:', e);
      ctx.showToast('Kon live route niet bijwerken: ' + e.message, 'info');
    } finally {
      if (typeof ctx.clearRouteUiStatus === 'function') ctx.clearRouteUiStatus(dateStr, ['optimizing']);
    }
  }

  async function confirmReschedule(ctx) {
    if (confirmReschedule._inFlight) return;
    const a = ctx.findAppointmentById(ctx.getRescheduleId());
    if (!a) return;
    const routeDate = ctx.getDateStr(ctx.getCurrentDate());
    const newDate = document.getElementById('rDate')?.value;
    const slotKeyRaw = document.getElementById('rSlot')?.value;
    const slotConfig = window.HKPlannerUtils?.getPlannerSlotConfig
      ? window.HKPlannerUtils.getPlannerSlotConfig(slotKeyRaw)
      : { key: 'morning', label: '09:00–13:00', startTime: '09:00', dayPart: 0 };
    const newTime = slotConfig.startTime;
    const newTimeWindow = document.getElementById('rTimeWindow')?.value?.trim() || slotConfig.label || null;
    const todayVal = ctx.getDateStr(ctx.getCurrentDate());
    const prevDate = todayVal;
    const moveBtn = document.querySelector('#rescheduleOverlay .btn-save');
    confirmReschedule._inFlight = true;
    if (moveBtn) {
      moveBtn.disabled = true;
      moveBtn.textContent = '⏳ Verplaatsen...';
    }
    ctx.closeRescheduleModal();
    ctx.showToast('⏳ Afspraak herplannen in GHL...', 'loading');
    try {
      if (a.id && !String(a.id).startsWith('local-')) {
        const res = await fetch('/api/ghl?action=rescheduleAppointment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
          body: JSON.stringify({
            ghlAppointmentId: a.id,
            contactId: a.contactId || '',
            newDate: newDate || todayVal,
            prevDate,
            newTime,
            slotKey: slotConfig.key,
            slotLabel: slotConfig.label,
            newTimeWindow,
            type: a.jobType,
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || d.detail || `Herplannen mislukt (${res.status})`);
        }
      }

      const targetDate = window.HKPlannerUtils?.plannerDateFromYmd
        ? window.HKPlannerUtils.plannerDateFromYmd(newDate || todayVal)
        : null;
      if (targetDate && typeof ctx.setCurrentDate === 'function') {
        ctx.setCurrentDate(targetDate);
      }
      const nextCurrentDate = ctx.getCurrentDate();
      await ctx.loadAppointments(nextCurrentDate, { plannerLoadQuiet: true });
      ctx.showToast(
        `✓ ${a.name} verplaatst naar ${newDate !== todayVal ? `${newDate} ` : ''}${slotConfig.label}`,
        'success'
      );
    } catch (e) {
      ctx.showToast(`⚠ Verplaatsen mislukt: ${e.message || e}`, 'info');
    } finally {
      confirmReschedule._inFlight = false;
      if (moveBtn) {
        moveBtn.disabled = false;
        moveBtn.textContent = '↗ Verplaatsen';
      }
    }
  }

  global.HKPlannerScheduling = {
    optimizeRoute,
    confirmReschedule,
  };
})(window);
