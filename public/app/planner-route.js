(function initPlannerRoute(global) {
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
    const dateStr =
      typeof ctx.getDateStr === 'function' ? ctx.getDateStr(ctx.getCurrentDate()) : '';
    const locationId =
      typeof ctx.getPlannerLocationId === 'function' ? ctx.getPlannerLocationId() : '';
    const updatedBy =
      typeof ctx.getCurrentPlannerUser === 'function' ? ctx.getCurrentPlannerUser() : 'manual';
    if (!dateStr || !locationId) {
      ctx.showToast('Geen datum of locatie — herlaad de planner', 'info');
      return { ok: false };
    }
    ctx.showToast('☀️ Ochtendmeldingen worden verstuurd...', 'loading');
    try {
      const res = await fetch('/api/ghl?action=sendMorningMessages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({ dateStr, locationId, updatedBy, by: 'manual' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        ctx.showToast(data?.error || `Ochtendmeldingen mislukt (${res.status})`, 'info');
        return { ok: false, data };
      }
      const sent = Number(data?.sent) || 0;
      if (data?.skipped && sent === 0) {
        ctx.showToast('Geen ingeplande klanten om te melden', 'info');
      } else {
        ctx.showToast(
          `☀️ Verstuurd naar ${sent} klant${sent === 1 ? '' : 'en'}`,
          'success'
        );
      }
      if (typeof ctx.refreshMorningMessageSettings === 'function') {
        await ctx.refreshMorningMessageSettings();
      }
      if (typeof ctx.render === 'function') ctx.render();
      return { ok: true, data };
    } catch {
      ctx.showToast('⚠ Ochtendmeldingen niet verstuurd: geen verbinding', 'info');
      return { ok: false };
    }
  }

  global.HKPlannerRoute = {
    sendETA,
    sendMorningMessages,
  };
})(window);
