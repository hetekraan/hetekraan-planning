(function initPlannerScheduling(global) {
  /**
   * Route-optimalisatie via `/api/optimize-route` met `mode: "partitionedDay"`:
   * depot → ochtend (09:00–13:00, eerste stop 09:00) → overgang laatste ochtend → middag (≥13:00, 13:00–17:00)
   * → optioneel reistijd terug naar depot in API-response.
   */
  async function optimizeRoute(ctx) {
    const dateStr = ctx.getDateStr(ctx.getCurrentDate());
    if (typeof ctx.isRouteOperationalLocked === 'function' && ctx.isRouteOperationalLocked(dateStr)) {
      ctx.showToast('Route is vergrendeld na “Bevestig route”. Ontgrendel eerst (🔓).', 'info');
      return;
    }
    const active = ctx.orderRouteMorningFirst(ctx.getRouteStopsForSidebar());
    const done = ctx.getAppointmentsRef().filter((a) => !a.fullAddressLine || a.status === 'klaar');
    if (active.length < 2) {
      ctx.showToast('Minimaal 2 adressen nodig om te optimaliseren', 'info');
      return;
    }

    function apptPayload(a) {
      return {
        address: a.fullAddressLine || a.address,
        timeWindow: a.timeWindow || null,
        jobDuration: ctx.jobDurationForType(a.jobType),
        dayPart: a.dayPart,
        bookingLocked: !!a.bookingLocked,
        internalFixedStart: a.internalFixedStartTime || undefined,
      };
    }

    ctx.showToast('⏳ Route wordt geoptimaliseerd...', 'loading');
    try {
      const res = await fetch('/api/optimize-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'partitionedDay',
          returnToDepot: true,
          appointments: active.map(apptPayload),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Onbekende fout');
      if (data.mode !== 'partitionedDay' || !Array.isArray(data.order) || !Array.isArray(data.etas)) {
        throw new Error('Route-API: onverwacht antwoord (partitionedDay)');
      }

      const optimized = data.order.map((i) => active[i]);
      optimized.forEach((a) => {
        a.violation = false;
      });
      data.order.forEach((apptIdx, step) => {
        const appt = active[apptIdx];
        if (appt) {
          appt.timeSlot = data.etas[step];
          appt.estimated = true;
        }
      });
      if (data.violations?.length) {
        data.violations.forEach((v) => {
          const step = data.order.indexOf(v.apptIdx);
          if (step >= 0 && optimized[step]) optimized[step].violation = true;
        });
      }

      ctx.setAppointments([...optimized, ...done]);
      if (typeof ctx.setConfirmedRouteOrder === 'function') {
        ctx.setConfirmedRouteOrder(
          dateStr,
          optimized.map((a) => (a?.contactId ? String(a.contactId) : '')).filter(Boolean)
        );
      }

      if (typeof ctx.setLastPartitionedRoutePlan === 'function') {
        ctx.setLastPartitionedRoutePlan(dateStr, {
          contactIdsOrder: optimized.map((a) => (a?.contactId ? String(a.contactId) : '')).filter(Boolean),
          legInfo: Array.isArray(data.legInfo) ? data.legInfo : [],
          returnLegToDepotMinutes: Number.isFinite(Number(data.returnLegToDepotMinutes))
            ? Number(data.returnLegToDepotMinutes)
            : undefined,
        });
      }

      const legSecs = (data.legInfo || []).reduce((s, l) => s + (l.durationSeconds || 0), 0);
      const returnMin = Number(data.returnLegToDepotMinutes);
      const totalTravelMins = Math.round(legSecs / 60) + (Number.isFinite(returnMin) ? returnMin : 0);
      const vCount = optimized.filter((a) => a.violation).length;
      const violationMsg = vCount > 0 ? ` · ⚠️ ${vCount} tijdsvenster${vCount > 1 ? 's' : ''} niet haalbaar` : '';

      const btn = document.getElementById('btnOptimize');
      const unlock = document.getElementById('btnUnlock');
      if (btn) btn.disabled = false;
      if (unlock) unlock.style.display = 'none';
      ctx.saveRouteSnapshot(dateStr);
      ctx.showToast(
        `⚡ Route geoptimaliseerd (09–13 / 13–17, depot)\n${active.length} stops · ~${totalTravelMins} min rijden (incl. terug depot indien berekend)${violationMsg}`,
        'success'
      );
      ctx.render();
    } catch (e) {
      console.error('Optimalisatie mislukt:', e);
      ctx.showToast('Kon route niet optimaliseren: ' + e.message, 'info');
    }
  }

  async function confirmReschedule(ctx) {
    if (confirmReschedule._inFlight) return;
    const a = ctx.findAppointmentById(ctx.getRescheduleId());
    if (!a) return;
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
      await ctx.loadAppointments(nextCurrentDate);
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
