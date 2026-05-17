(function initPlannerNextEta(global) {
  function cleanString(v) {
    return String(v || '').trim();
  }

  async function fetchNextEtaPreview(ctx, currentContactId) {
    const locationId =
      typeof ctx.getPlannerLocationId === 'function' ? ctx.getPlannerLocationId() : '';
    const dateStr =
      typeof ctx.getDateStr === 'function' ? ctx.getDateStr(ctx.getCurrentDate()) : '';
    if (!locationId || !dateStr || !currentContactId) {
      return { ok: false, code: 'MISSING_CONTEXT' };
    }
    const qs = new URLSearchParams({
      locationId,
      dateStr,
      currentContactId: cleanString(currentContactId),
    });
    try {
      const res = await fetch(`/api/route/next-eta-preview?${qs.toString()}`, {
        cache: 'no-store',
        headers: { 'X-HK-Auth': ctx.hkAuthHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, code: data.code || 'PREVIEW_FAILED', data };
      return data;
    } catch (e) {
      return { ok: false, code: 'PREVIEW_FAILED', error: e?.message || String(e) };
    }
  }

  async function postSendNextEta(ctx, payload) {
    const locationId =
      typeof ctx.getPlannerLocationId === 'function' ? ctx.getPlannerLocationId() : '';
    const dateStr =
      typeof ctx.getDateStr === 'function' ? ctx.getDateStr(ctx.getCurrentDate()) : '';
    const revision =
      typeof ctx.getRouteStateRevisionForDate === 'function'
        ? ctx.getRouteStateRevisionForDate(dateStr)
        : 0;
    if (!locationId || !dateStr) return { ok: false, code: 'MISSING_CONTEXT' };
    try {
      const res = await fetch('/api/route/send-next-eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({
          locationId,
          dateStr,
          revision,
          expectedRevision: revision,
          updatedBy:
            typeof ctx.getCurrentPlannerUser === 'function' ? ctx.getCurrentPlannerUser() : 'planner',
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, code: data.code || 'ETA_SEND_FAILED', data };
      return data;
    } catch (e) {
      return { ok: false, code: 'ETA_SEND_FAILED', error: e?.message || String(e) };
    }
  }

  function markEtaSentLocally(ctx, contactId, sentEta, sentAt) {
    if (typeof ctx.markEtaSentForContact === 'function') {
      ctx.markEtaSentForContact(contactId, sentEta, sentAt);
    }
  }

  async function sendNextEtaForContact(ctx, { currentContactId, nextContactId, eta }) {
    const out = await postSendNextEta(ctx, {
      currentContactId: cleanString(currentContactId),
      nextContactId: cleanString(nextContactId),
      eta: cleanString(eta),
    });
    if (!out.ok) return out;
    markEtaSentLocally(ctx, nextContactId, out.sentEta, Date.now());
    if (out.routeState && typeof ctx.syncLiveRouteState === 'function') {
      const dateStr =
        typeof ctx.getDateStr === 'function' ? ctx.getDateStr(ctx.getCurrentDate()) : '';
      if (dateStr) ctx.syncLiveRouteState(dateStr, out.routeState);
    }
    return out;
  }

  async function maybeShowNextEtaPromptAfterKlaar(ctx, completedAppointment) {
    const appt = completedAppointment;
    if (!appt?.contactId || appt.isCalBlock) return;
    const preview = await fetchNextEtaPreview(ctx, appt.contactId);
    if (preview?.ok === true && !preview.nextContact) return;
    if (preview?.code === 'MISSING_ADDRESS') {
      console.warn('[planner-next-eta] skip prompt: missing address', appt.contactId);
      return;
    }
    if (typeof ctx.showNextEtaPrompt === 'function') {
      ctx.showNextEtaPrompt({
        afterContactId: appt.contactId,
        nextContact: preview.nextContact || null,
        etaTime: preview.etaTime || null,
        calcFailed: preview.code === 'ETA_CALC_FAILED' || preview.ok === false,
      });
    }
  }

  async function sendOnderwegEtaForAppointment(ctx, appointmentId) {
    const find =
      typeof ctx.findAppointmentById === 'function'
        ? ctx.findAppointmentById
        : (id) => ctx.getAppointmentsRef?.().find((a) => String(a.id) === String(id));
    const a = find(appointmentId);
    if (!a?.contactId || a.isCalBlock) {
      ctx.showToast('Geen route-klant om ETA naar te sturen', 'info');
      return { ok: false };
    }
    const dateStr =
      typeof ctx.getDateStr === 'function' ? ctx.getDateStr(ctx.getCurrentDate()) : '';
    const routeState =
      typeof ctx.getLiveRouteState === 'function' ? ctx.getLiveRouteState(dateStr) : null;
    const order = Array.isArray(routeState?.orderContactIds) ? routeState.orderContactIds : [];
    let currentContactId = '';
    const idx = order.indexOf(String(a.contactId));
    if (idx > 0) currentContactId = order[idx - 1];
    const eta = cleanString(a.timeSlot);
    const wasOnderweg =
      String(a.status || '').toLowerCase() === 'onderweg' ||
      (typeof ctx.getEtaSentMetaForContact === 'function' &&
        ctx.getEtaSentMetaForContact(a.contactId, dateStr));
    ctx.showToast('⏳ ETA versturen…', 'loading');
    const out = await sendNextEtaForContact(ctx, {
      currentContactId,
      nextContactId: a.contactId,
      eta,
    });
    if (!out.ok) {
      ctx.showToast(
        out.code === 'STALE_CONTACT_ID'
          ? 'Route is veranderd — herlaad de dag'
          : 'ETA versturen mislukt',
        'info'
      );
      return out;
    }
    ctx.showToast(
      wasOnderweg
        ? `📱 ETA opnieuw verstuurd (${out.sentEta})`
        : `📱 ETA verstuurd (${out.sentEta})`,
      'success'
    );
    if (typeof ctx.applyRouteSnapshot === 'function') ctx.applyRouteSnapshot(dateStr);
    if (typeof ctx.render === 'function') ctx.render();
    return out;
  }

  global.HKPlannerNextEta = {
    fetchNextEtaPreview,
    postSendNextEta,
    sendNextEtaForContact,
    maybeShowNextEtaPromptAfterKlaar,
    sendOnderwegEtaForAppointment,
  };
})(window);
