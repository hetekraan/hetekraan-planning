(function initPlannerActions(global) {
  let hkGhlBlockDayInFlight = false;

  async function confirmDeleteAppt(ctx) {
    const {
      getRescheduleId,
      findAppointmentById,
      closeRescheduleModal,
      showToast,
      setAppointments,
      getAppointmentsRef,
      hkAuthHeader,
      getDateStr,
      getCurrentDate,
      loadAppointments,
      render,
    } = ctx;
    const rid = getRescheduleId();
    if (rid == null) return;
    const a = findAppointmentById(rid);
    closeRescheduleModal();
    if (!a) return;
    showToast('⏳ Boeking verwijderen en GHL reset…', 'loading');
    if (!a.contactId) {
      setAppointments(getAppointmentsRef().filter((x) => String(x.id) !== String(a.id)));
      render();
      showToast('Rij verwijderd (geen GHL contactId)', 'info');
      return;
    }
    try {
      const res = await fetch('/api/ghl?action=deletePlannerBooking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
        body: JSON.stringify({
          contactId: a.contactId,
          routeDate: getDateStr(getCurrentDate()),
          rowId: a.id,
          isSyntheticB1: !!a.isSyntheticBlockBooking,
          isCalBlock: !!a.isCalBlock,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(`⚠ ${d.error || res.status}${d.detail ? ': ' + String(d.detail).slice(0, 80) : ''}`, 'info');
        return;
      }
      if (d.ghlAppointment?.attempted && d.ghlAppointment.ok === false) {
        showToast('⚠ Boeking vrijgegeven in Redis/contact; GHL-afspraak niet verwijderd — controleer de agenda', 'info');
      } else {
        showToast('✓ Boeking verwijderd / ge-reset', 'success');
      }
      await loadAppointments(getCurrentDate());
    } catch (e) {
      showToast('⚠ Verwijderen mislukt: ' + (e.message || e), 'info');
    }
  }

  async function confirmDone(ctx, id) {
    const {
      findAppointmentById,
      showToast,
      calcTotalPrice,
      hkAuthHeader,
      getDateStr,
      getCurrentDate,
      showPaymentLinkFallback,
      saveKlaarStatus,
      render,
      appointmentDomSafeId,
    } = ctx;
    const a = findAppointmentById(id);
    if (!a) return;
    showToast('⏳ Bezig met afronden...', 'loading');
    const total = calcTotalPrice(a);
    const lines = a.extras || [];
    const contact = a.contact || {};
    const routeDate = getDateStr(getCurrentDate());
    const domId = appointmentDomSafeId(id);
    const sdateEl = document.getElementById(`sdate-${domId}`);
    let lastMaintenance = String(sdateEl?.value || '').trim();
    if (!lastMaintenance) lastMaintenance = String(a.lastService || '').trim();
    if (!lastMaintenance) lastMaintenance = routeDate;
    if (a.contactId) {
      try {
        const ghlRes = await fetch('/api/ghl?action=completeAppointment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
          body: JSON.stringify({
            contactId: a.contactId,
            appointmentId: a.id || undefined,
            type: a.jobType,
            sendReview: a.review,
            lastService: lastMaintenance,
            totalPrice: total,
            extras: lines,
            routeDate,
          }),
        });
        if (!ghlRes.ok) showToast(`⚠ GHL kon niet worden bijgewerkt (${ghlRes.status}) — afspraak wel klaar gezet`, 'info');
      } catch {
        showToast('⚠ GHL niet bereikbaar — afspraak wel klaar gezet', 'info');
      }
    }
    if (a.contactId && total > 0) {
      try {
        const resp = await fetch('/api/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
          body: JSON.stringify({
            contactId: a.contactId,
            contactName: a.name,
            contactEmail: contact.email || '',
            contactAddress: a.fullAddressLine || a.address,
            contactCity: contact.city || a.city || '',
            lines,
            basePrice: a.price || 0,
            appointmentDesc: a.jobDescription || 'Werkzaamheden',
          }),
        });
        const result = await resp.json();
        if (resp.status === 401) showToast('⚠ Sessie verlopen — log opnieuw in om betaallink te sturen', 'info');
        else if (result.mollieError) showToast(`✓ Klaar!\n⚠ Mollie kon geen betaallink aanmaken: ${result.mollieError.slice(0, 100)}`, 'info');
        else if (result.paymentUrl && !(result.ghlDiag || {}).tagSet) showPaymentLinkFallback(result.paymentUrl, result.invoiceNumber, result.totalInclBTW);
      } catch {}
    }
    a.status = 'klaar';
    a.priceVisible = false;
    saveKlaarStatus(a.id, a.contactId, getDateStr(getCurrentDate()));
    render();
    requestAnimationFrame(() => {
      const card = document.getElementById('card-' + appointmentDomSafeId(id));
      if (card) {
        card.classList.add('just-done');
        card.addEventListener('animationend', () => card.classList.remove('just-done'), { once: true });
      }
    });
  }

  function dayIsBlockedForCtx(ctx) {
    const dateStr = ctx.getDateStr(ctx.getCurrentDate());
    const blocks = ctx.getAppointmentsRef().filter((x) => x.isCalBlock);
    const dashPending = ctx.isDashBlockedPending(dateStr) && blocks.length === 0;
    return blocks.length > 0 || dashPending;
  }

  function onBlockDayButtonClick(ctx) {
    if (dayIsBlockedForCtx(ctx)) unblockCurrentDayInGhl(ctx);
    else openDayBlockChoiceModal(ctx);
  }

  function openDayBlockChoiceModal(ctx) {
    const labelEl = document.getElementById('dayBlockChoiceDateLabel');
    if (labelEl) labelEl.textContent = ctx.formatDate(ctx.getCurrentDate());
    const tgl = document.getElementById('btnCustomerDayFullToggle');
    if (tgl) {
      const on = ctx.getPlannerCustomerDayFull?.() === true;
      tgl.textContent = on
        ? 'Dag weer openzetten voor klantboekingen'
        : 'Dag is vol (geen nieuwe klantboekingen)';
    }
    const hint = document.getElementById('dayBlockChoiceCustomerFullHint');
    if (hint) {
      if (ctx.getPlannerCustomerDayFullStoreConfigured?.() === true) {
        hint.style.display = 'none';
        hint.textContent = '';
      } else {
        hint.style.display = 'block';
        hint.textContent =
          '“Dag is vol” slaat op in Upstash Redis (UPSTASH_REDIS_REST_URL + TOKEN), hetzelfde als Model B-reserveringen. Zonder Redis kun je alleen GHL-blok gebruiken.';
      }
    }
    document.getElementById('dayBlockChoiceOverlay')?.classList.add('visible');
  }

  function closeDayBlockChoiceModal() {
    document.getElementById('dayBlockChoiceOverlay')?.classList.remove('visible');
  }

  async function applyDayBlockChoice(dayPart, ctx) {
    closeDayBlockChoiceModal();
    if (dayPart === 'customerDayFull') {
      return toggleCustomerDayFull(ctx);
    }
    return blockCurrentDayInGhl(ctx, { dayPart, skipConfirm: true });
  }

  async function toggleCustomerDayFull(ctx) {
    const dateStr = ctx.getDateStr(ctx.getCurrentDate());
    const currently = ctx.getPlannerCustomerDayFull?.() === true;
    const next = !currently;
    ctx.showToast(next ? '⏳ Dag vol zetten voor klanten…' : '⏳ Klantboekingen weer openzetten…', 'loading');
    try {
      const res = await fetch('/api/ghl?action=setCustomerDayFull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({ date: dateStr, full: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Fout ${res.status}`);
      }
      ctx.setPlannerCustomerDayFull?.(!!data.customerDayFull);
      ctx.showToast(
        next
          ? '✓ Deze dag staat vol voor klanten (online boeken/suggesties uit)'
          : '✓ Klanten kunnen deze dag weer boeken',
        'success'
      );
      await ctx.loadAppointments(ctx.getCurrentDate());
    } catch (e) {
      ctx.showToast(String(e.message || e), 'info');
    }
  }

  async function unblockCurrentDayInGhl(ctx) {
    const dateStr = ctx.getDateStr(ctx.getCurrentDate());
    const label = ctx.formatDate(ctx.getCurrentDate());
    const blocks = ctx.getAppointmentsRef().filter((a) => a.isCalBlock);
    const ids = [...new Set(blocks.map((a) => a.id).filter(Boolean))];
    const onlyPending = blocks.length === 0 && ctx.isDashBlockedPending(dateStr);
    if (!confirm(`Weet je het zeker dat je de blokkade wil opheffen en de dag weer wil vrijgeven?\n\n${label}`)) return;
    if (onlyPending) {
      ctx.clearDashBlockedDate(dateStr);
      ctx.showToast('✓ Melding gewist. Er stond nog geen zichtbaar blokslot in het dashboard — controleer zo nodig GHL.', 'success');
      await ctx.loadAppointments(ctx.getCurrentDate());
      return;
    }
    ctx.showToast('⏳ Blokkade opheffen in GHL...', 'loading');
    try {
      const res = await fetch('/api/ghl?action=unblockCalendarDay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify({ date: dateStr, ghlBlockEventIds: ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
      ctx.clearDashBlockedDate(dateStr);
      await ctx.loadAppointments(ctx.getCurrentDate());
    } catch (e) {
      ctx.showToast(String(e.message || e), 'info');
    }
  }

  async function blockCurrentDayInGhl(ctx, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const skipConfirm = options.skipConfirm === true;
    const rawPart = String(options.dayPart || 'full').toLowerCase();
    const dayPart = rawPart === 'morning' || rawPart === 'afternoon' ? rawPart : 'full';
    const dateStr = ctx.getDateStr(ctx.getCurrentDate());
    const label = ctx.formatDate(ctx.getCurrentDate());
    if (!skipConfirm) {
      if (
        !confirm(
          `Hele kalenderdag blokkeren in GHL voor ${label}?\n\nEr komt een officiële blokslot (hele dag). Online boeken slaat deze datum daarna volledig over — totdat je de blokkade weer opheft of het blok in GHL verwijdert.\n\nLet op: kortere blokken die je alleen in GHL zet kunnen óók de hele datum voor klanten sluiten (overlap met 08–18 Amsterdam).`
        )
      ) {
        return;
      }
    }
    if (hkGhlBlockDayInFlight) return;
    hkGhlBlockDayInFlight = true;
    const blockBtn = document.getElementById('btnBlockDayGhl');
    if (blockBtn) blockBtn.disabled = true;
    ctx.showToast('⏳ Blokslot aanmaken in GHL...', 'loading');
    try {
      const body = { date: dateStr, dayPart };
      if (dayPart === 'full') body.title = 'Dag geblokkeerd';
      const res = await fetch('/api/ghl?action=blockCalendarDay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
      if (!data.alreadyBlocked) ctx.markDashBlockedDate(dateStr);
      await ctx.loadAppointments(ctx.getCurrentDate());
    } catch (e) {
      ctx.showToast(String(e.message || e), 'info');
    } finally {
      hkGhlBlockDayInFlight = false;
      ctx.render();
    }
  }

  global.HKPlannerActions = {
    confirmDeleteAppt,
    confirmDone,
    onBlockDayButtonClick,
    dayIsBlockedForCtx,
    openDayBlockChoiceModal,
    closeDayBlockChoiceModal,
    applyDayBlockChoice,
    blockCurrentDayInGhl,
    unblockCurrentDayInGhl,
  };
})(window);
