(function initPlannerScheduling(global) {
  /**
   * Dagdelen blijven strikt gescheiden: alleen ochtendstops worden onderling geoptimaliseerd,
   * alleen middagstops onderling. Middag-run start vanaf het adres van de laatste ochtendstop
   * (body.origin) zodat de eerste middagstop dichter bij de overgang ligt; daarna volledige dag-ETAs.
   */
  async function optimizeRoute(ctx) {
    const active = ctx.orderRouteMorningFirst(ctx.getRouteStopsForSidebar());
    const done = ctx.getAppointmentsRef().filter((a) => !a.fullAddressLine || a.status === 'klaar');
    if (active.length < 2) {
      ctx.showToast('Minimaal 2 adressen nodig om te optimaliseren', 'info');
      return;
    }

    const morning = active.filter((a) => a.dayPart === 0);
    const afternoon = active.filter((a) => a.dayPart !== 0);

    function apptPayload(a) {
      return {
        address: a.fullAddressLine || a.address,
        timeWindow: a.timeWindow || null,
        jobDuration: ctx.jobDurationForType(a.jobType),
      };
    }

    async function runOptimizeSubset(apps, originAddress) {
      const body = { appointments: apps.map(apptPayload) };
      if (originAddress) body.origin = originAddress;
      const res = await fetch('/api/optimize-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Onbekende fout');
      const ordered = data.order.map((i) => apps[i]);
      const travel = (data.legInfo || []).reduce((s, l) => s + (l.durationSeconds || 0), 0);
      return { ordered, travel };
    }

    ctx.showToast('⏳ Route wordt geoptimaliseerd...', 'loading');
    try {
      let totalTravelSecs = 0;
      let orderedM = [...morning];
      let orderedA = [...afternoon];

      if (morning.length >= 2) {
        const r = await runOptimizeSubset(morning, null);
        orderedM = r.ordered;
        totalTravelSecs += r.travel;
      }
      if (afternoon.length >= 2) {
        const lastMorningAddr =
          orderedM.length > 0
            ? String(orderedM[orderedM.length - 1].fullAddressLine || orderedM[orderedM.length - 1].address || '').trim()
            : '';
        const r = await runOptimizeSubset(afternoon, lastMorningAddr || undefined);
        orderedA = r.ordered;
        totalTravelSecs += r.travel;
      }

      const optimized = [...orderedM, ...orderedA];
      optimized.forEach((a) => {
        a.violation = false;
      });
      await ctx.recalculateRouteTimesPreservingOrder(optimized);
      ctx.setAppointments([...optimized, ...done]);

      const totalTravelMins = Math.round(totalTravelSecs / 60);
      const vCount = optimized.filter((a) => a.violation).length;
      const violationMsg = vCount > 0 ? ` · ⚠️ ${vCount} tijdsvenster${vCount > 1 ? 's' : ''} niet haalbaar` : '';

      const btn = document.getElementById('btnOptimize');
      const unlock = document.getElementById('btnUnlock');
      if (btn) btn.disabled = false;
      if (unlock) unlock.style.display = 'none';
      ctx.saveRouteSnapshot(ctx.getDateStr(ctx.getCurrentDate()));
      ctx.showToast(
        `⚡ Route geoptimaliseerd (ochtend/middag apart)\n${active.length} stops · ~${totalTravelMins} min rijden (deelroutes)${violationMsg}`,
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
