(function initPlannerActions(global) {
  let hkGhlBlockDayInFlight = false;
  const invoiceRetryInFlightByApptId = new Set();

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
    let moneybirdHandled = false;
    /** @type {Record<string, unknown>|null} */
    let ghlDataAfterComplete = null;
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
            basePrice: Number(a.price) || 0,
            appointmentDesc: String(a.jobDescription || '').trim(),
            routeDate,
          }),
        });
        let ghlData = /** @type {Record<string, unknown>} */ ({});
        let jsonParseFailed = false;
        try {
          ghlData = await ghlRes.json();
        } catch {
          jsonParseFailed = true;
          ghlData = {};
        }
        ghlDataAfterComplete = ghlData;
        const rawKeys = Object.keys(ghlData || {});
        const mbRaw = Object.prototype.hasOwnProperty.call(ghlData, 'moneybird')
          ? ghlData.moneybird
          : undefined;
        const mb = mbRaw != null && typeof mbRaw === 'object' && !Array.isArray(mbRaw) ? mbRaw : null;
        const invoiceIdStr = mb && mb.invoiceId != null ? String(mb.invoiceId).trim() : '';
        const tokenStr =
          mb && (mb.invoiceToken != null || mb.invoicePayToken != null)
            ? String(mb.invoiceToken != null ? mb.invoiceToken : mb.invoicePayToken).trim()
            : '';
        moneybirdHandled =
          mb != null &&
          (mb.created === true ||
            invoiceIdStr !== '' ||
            mb.skipped === true ||
            tokenStr !== '');
        console.log(
          '[planner] completeAppointment_response',
          JSON.stringify({
            contactId: a.contactId,
            appointmentId: a.id != null ? String(a.id) : undefined,
            ghlStatus: ghlRes.status,
            ghlOk: ghlRes.ok,
            jsonParseFailed,
            rawKeys,
            hasMoneybirdObject: mb != null,
            moneybirdCreated: mb ? mb.created === true : false,
            moneybirdInvoiceId: invoiceIdStr || undefined,
            moneybirdSkipped: mb ? mb.skipped === true : false,
            moneybirdInvoiceToken: tokenStr || undefined,
            moneybirdHandled,
          })
        );
        if (!ghlRes.ok) showToast(`⚠ GHL kon niet worden bijgewerkt (${ghlRes.status}) — afspraak wel klaar gezet`, 'info');
      } catch {
        showToast('⚠ GHL niet bereikbaar — afspraak wel klaar gezet', 'info');
      }
    }
    const mbForLegacy = (() => {
      const d = ghlDataAfterComplete;
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'moneybird')) return null;
      const m = d.moneybird;
      if (m == null || typeof m !== 'object' || Array.isArray(m)) return null;
      return m;
    })();
    const invoiceIdForLegacy = mbForLegacy && mbForLegacy.invoiceId != null ? String(mbForLegacy.invoiceId).trim() : '';
    const tokenForLegacy =
      mbForLegacy && (mbForLegacy.invoiceToken != null || mbForLegacy.invoicePayToken != null)
        ? String(
            mbForLegacy.invoiceToken != null ? mbForLegacy.invoiceToken : mbForLegacy.invoicePayToken
          ).trim()
        : '';
    const willCallCreatePayment = Boolean(
      a.contactId && total > 0 && !moneybirdHandled
    );
    console.log(
      '[planner] legacy_mollie_check',
      JSON.stringify({
        contactId: a.contactId,
        appointmentId: a.id != null ? String(a.id) : undefined,
        total,
        hasMoneybirdObject: mbForLegacy != null,
        moneybirdCreated: mbForLegacy ? mbForLegacy.created === true : false,
        moneybirdInvoiceId: invoiceIdForLegacy || undefined,
        moneybirdSkipped: mbForLegacy ? mbForLegacy.skipped === true : false,
        moneybirdInvoiceToken: tokenForLegacy || undefined,
        willCallCreatePayment,
      })
    );
    if (a.contactId && total > 0 && moneybirdHandled) {
      console.log(
        '[planner] legacy_mollie_skipped_due_to_moneybird',
        JSON.stringify({
          contactId: a.contactId,
          appointmentId: a.id != null ? String(a.id) : undefined,
          total,
          hasMoneybirdObject: mbForLegacy != null,
          moneybirdCreated: mbForLegacy ? mbForLegacy.created === true : false,
          moneybirdInvoiceId: invoiceIdForLegacy || undefined,
          moneybirdSkipped: mbForLegacy ? mbForLegacy.skipped === true : false,
          moneybirdInvoiceToken: tokenForLegacy || undefined,
        })
      );
    }
    if (a.contactId && total > 0 && !moneybirdHandled) {
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
    saveKlaarStatus(a.id, a.contactId, getDateStr(getCurrentDate()));
    console.info(
      '[planner] completion_state_written',
      JSON.stringify({
        contactId: a.contactId || null,
        appointmentId: a.id != null ? String(a.id) : null,
        serviceDay: routeDate,
        layer: 'client_ui_and_localStorage',
      })
    );
    render();
    requestAnimationFrame(() => {
      const card = document.getElementById('card-' + appointmentDomSafeId(id));
      if (card) {
        card.classList.add('just-done');
        card.addEventListener('animationend', () => card.classList.remove('just-done'), { once: true });
      }
    });
  }

  async function retryInvoiceForDone(ctx, id, btnEl) {
    const {
      findAppointmentById,
      showToast,
      calcTotalPrice,
      hkAuthHeader,
      getDateStr,
      getCurrentDate,
      loadAppointments,
    } = ctx;
    const a = findAppointmentById(id);
    if (!a) return;
    if (a.status !== 'klaar') {
      showToast('Alleen afgeronde afspraken kunnen een factuur-retry doen.', 'info');
      return;
    }
    if (!a.contactId) {
      showToast('Geen GHL-contact gekoppeld aan deze afspraak.', 'info');
      return;
    }
    const key = String(a.id || id);
    if (invoiceRetryInFlightByApptId.has(key)) return;
    invoiceRetryInFlightByApptId.add(key);
    const btn = btnEl && typeof btnEl === 'object' ? btnEl : null;
    const prevTitle = btn?.title || 'Factuur opnieuw verzenden';
    if (btn) {
      btn.disabled = true;
      btn.title = 'Factuur retry bezig...';
      btn.setAttribute('aria-busy', 'true');
      btn.style.opacity = '0.6';
      btn.style.cursor = 'progress';
    }
    showToast('⏳ Factuur opnieuw verzenden...', 'loading');
    try {
      const total = calcTotalPrice(a);
      const lines = Array.isArray(a.extras) ? a.extras : [];
      const routeDate = getDateStr(getCurrentDate());
      const res = await fetch('/api/ghl?action=retryInvoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
        body: JSON.stringify({
          contactId: a.contactId,
          appointmentId: a.id || undefined,
          type: a.jobType,
          totalPrice: total,
          extras: lines,
          basePrice: Number(a.price) || 0,
          appointmentDesc: String(a.jobDescription || '').trim(),
          routeDate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || `Factuur kon niet verzonden worden (${res.status})`, 'info');
        return;
      }
      const action = String(data?.actionTaken || '').trim();
      if (action === 'created_and_sent_email') {
        showToast('Factuur aangemaakt en verzonden', 'success');
      } else if (action === 'reused_and_sent_email') {
        showToast('Bestaande factuur opnieuw verzonden', 'success');
      } else if (action === 'already_sent_noop') {
        showToast('Factuur bestond al en was al verzonden', 'info');
      } else if (action === 'missing_email') {
        showToast('Geen e-mailadres beschikbaar', 'info');
      } else if (action === 'whatsapp_sent') {
        showToast('WhatsApp opnieuw verstuurd', 'success');
      } else if (String(data?.message || '').trim()) {
        showToast(String(data.message).trim(), 'info');
      } else {
        showToast('Factuur retry afgerond', 'success');
      }
      await loadAppointments(getCurrentDate());
    } catch (e) {
      showToast('Factuur kon niet verzonden worden', 'info');
    } finally {
      invoiceRetryInFlightByApptId.delete(key);
      if (btn) {
        btn.disabled = false;
        btn.title = prevTitle;
        btn.removeAttribute('aria-busy');
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
    }
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
    retryInvoiceForDone,
    onBlockDayButtonClick,
    dayIsBlockedForCtx,
    openDayBlockChoiceModal,
    closeDayBlockChoiceModal,
    applyDayBlockChoice,
    blockCurrentDayInGhl,
    unblockCurrentDayInGhl,
  };
})(window);
