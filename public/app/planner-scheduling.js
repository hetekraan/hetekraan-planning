(function initPlannerScheduling(global) {
  async function optimizeRoute(ctx) {
    const active = ctx.orderRouteMorningFirst(ctx.getRouteStopsForSidebar());
    const done = ctx.getAppointmentsRef().filter((a) => !a.fullAddressLine || a.status === 'klaar');
    if (active.length < 2) {
      ctx.showToast('Minimaal 2 adressen nodig om te optimaliseren', 'info');
      return;
    }
    ctx.showToast('⏳ Route wordt geoptimaliseerd...', 'loading');
    try {
      const res = await fetch('/api/optimize-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appointments: active.map((a) => ({
            address: a.fullAddressLine || a.address,
            timeWindow: a.timeWindow || null,
            jobDuration: ctx.jobDurationForType(a.jobType),
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Onbekende fout');

      const orderIdx = data.order;
      const morningIdx = orderIdx.filter((i) => active[i].dayPart === 0);
      const afternoonIdx = orderIdx.filter((i) => active[i].dayPart !== 0);
      const stableOrder = [...morningIdx, ...afternoonIdx];
      const optimized = stableOrder.map((i) => active[i]);
      optimized.forEach((a) => {
        a.violation = false;
      });
      await ctx.recalculateRouteTimesPreservingOrder(optimized);
      ctx.setAppointments([...optimized, ...done]);

      const totalTravel = (data.legInfo || []).reduce((s, l) => s + (l.durationSeconds || 0), 0);
      const totalTravelMins = Math.round(totalTravel / 60);
      const vCount = optimized.filter((a) => a.violation).length;
      const violationMsg = vCount > 0 ? ` · ⚠️ ${vCount} tijdsvenster${vCount > 1 ? 's' : ''} niet haalbaar` : '';

      const btn = document.getElementById('btnOptimize');
      const unlock = document.getElementById('btnUnlock');
      if (btn) btn.disabled = false;
      if (unlock) unlock.style.display = 'none';
      ctx.saveRouteSnapshot(ctx.getDateStr(ctx.getCurrentDate()));
      ctx.showToast(`⚡ Route geoptimaliseerd!\n${active.length} stops · ~${totalTravelMins} min rijden${violationMsg}`, 'success');
      ctx.render();
    } catch (e) {
      console.error('Optimalisatie mislukt:', e);
      ctx.showToast('Kon route niet optimaliseren: ' + e.message, 'info');
    }
  }

  async function confirmReschedule(ctx) {
    const a = ctx.findAppointmentById(ctx.getRescheduleId());
    if (!a) return;
    const newDate = document.getElementById('rDate')?.value;
    const newTime = document.getElementById('rTime')?.value;
    const newTimeWindow = document.getElementById('rTimeWindow')?.value?.trim() || null;
    const todayVal = ctx.getDateStr(ctx.getCurrentDate());
    ctx.closeRescheduleModal();
    if (newDate && newDate !== todayVal) {
      ctx.setAppointments(ctx.getAppointmentsRef().filter((x) => String(x.id) !== String(ctx.getRescheduleId())));
    } else {
      a.timeSlot = newTime;
      a.timeWindow = newTimeWindow;
      a.estimated = false;
    }
    ctx.render();
    ctx.showToast('⏳ Afspraak herplannen in GHL...', 'loading');
    if (a.id && !String(a.id).startsWith('local-')) {
      try {
        const res = await fetch('/api/ghl?action=rescheduleAppointment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
          body: JSON.stringify({
            ghlAppointmentId: a.id,
            newDate: newDate || todayVal,
            newTime,
            type: a.jobType,
          }),
        });
        if (res.ok) {
          ctx.showToast(`✓ ${a.name} verplaatst naar ${newDate !== todayVal ? newDate + ' ' : ''}${newTime} in GHL`, 'success');
        } else {
          const d = await res.json().catch(() => ({}));
          ctx.showToast(`⚠ Lokaal bijgewerkt, GHL mislukt: ${d.error || res.status}`, 'info');
        }
      } catch {
        ctx.showToast('⚠ Lokaal bijgewerkt, GHL niet bereikbaar', 'info');
      }
    } else {
      ctx.showToast(`${a.name} verplaatst naar ${newTime}`, 'success');
    }
  }

  global.HKPlannerScheduling = {
    optimizeRoute,
    confirmReschedule,
  };
})(window);
