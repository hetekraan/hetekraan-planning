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

  global.HKPlannerRoute = {
    sendETA,
    sendMorningMessages,
  };
})(window);
