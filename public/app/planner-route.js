(function initPlannerRoute(global) {
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
      const res = await fetch('/api/ghl?action=saveRouteTimes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({
          routeTimes: toSave,
          routeLock: {
            dateStr: routeDate,
            locked: true,
            orderContactIds,
            etasByContactId,
            updatedBy: plannerUser || 'unknown',
          },
        }),
      });
      const data = await res.json();
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
      if (typeof ctx.setConfirmedRouteOrder === 'function') {
        ctx.setConfirmedRouteOrder(
          routeDate,
          orderContactIds
        );
      }
      if (typeof ctx.saveRouteOperationalLock === 'function') {
        ctx.saveRouteOperationalLock(routeDate, { orderContactIds, etasByContactId });
      }
      ctx.saveRouteSnapshot(routeDate);
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
  };
})(window);
