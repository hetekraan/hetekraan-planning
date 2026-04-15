(function initPlannerManualAppointment(global) {
  let inFlight = false;
  let totalPriceManual = false;
  let totalPriceManualValue = null;
  let modalMode = 'create';
  let editingMeta = null;

  function isDebugEnabled() {
    try {
      return localStorage.getItem('hk_debug_manual_appt') === '1';
    } catch (_) {
      return false;
    }
  }

  function debug(step, payload) {
    if (!isDebugEnabled()) return;
    try {
      console.debug(`[MANUAL_APPT_DEBUG] ${step}`, payload || {});
    } catch (_) {}
  }

  /** Zet in console: localStorage.setItem('hk_trace_edit_address','1') — adres-flow end-to-end. */
  function traceEditAddress(tag, payload) {
    try {
      if (localStorage.getItem('hk_trace_edit_address') !== '1') return;
      console.info(`[edit_modal] ${tag}`, payload ?? {});
    } catch (_) {}
  }

  function normalizeYmdToDate(ymd) {
    if (global.HKPlannerUtils?.plannerDateFromYmd) {
      return global.HKPlannerUtils.plannerDateFromYmd(ymd);
    }
    return null;
  }

  function roundPrice(v) {
    return Math.round(Number(v || 0) * 100) / 100;
  }

  function parseManualPriceInput(raw) {
    const normalized = String(raw || '').trim().replace(',', '.');
    if (!normalized) return { empty: true, value: null };
    const n = Number(normalized);
    if (!Number.isFinite(n) || n < 0) return { empty: false, invalid: true, value: null };
    return { empty: false, invalid: false, value: roundPrice(n) };
  }

  function readAutoTotalFromPriceLines() {
    const lines = global.HKPlannerCatalogV1?.getModalCatalogLines
      ? global.HKPlannerCatalogV1.getModalCatalogLines()
      : [];
    return roundPrice(lines.reduce((sum, row) => sum + Number(row.price || 0), 0));
  }

  function calcLinesTotal(lines) {
    const src = Array.isArray(lines) ? lines : [];
    return roundPrice(src.reduce((sum, row) => sum + Number(row?.price || 0), 0));
  }

  function updateManualHint() {
    const hint = document.getElementById('mPriceManualHint');
    if (!hint) return;
    hint.textContent = totalPriceManual ? 'Handmatig aangepast' : '';
  }

  function setModalUiMode(mode) {
    modalMode = mode === 'edit' ? 'edit' : 'create';
    const titleEl = document.getElementById('mModalTitle');
    const btn = document.getElementById('btnModalAddAppt');
    if (titleEl) titleEl.textContent = modalMode === 'edit' ? 'Afspraak bewerken' : 'Nieuwe afspraak';
    if (btn) btn.textContent = modalMode === 'edit' ? 'Wijzigingen opslaan' : 'Toevoegen';
  }

  function collectFormValues() {
    const dateInput = document.getElementById('mDate');
    const slotInput = document.getElementById('mSlot');
    const typeInput = document.getElementById('mType');
    const nameInput = document.getElementById('mName');
    const addressInput = document.getElementById('mAddress');
    const phoneInput = document.getElementById('mPhone');
    const emailInput = document.getElementById('mEmail');
    const descInput = document.getElementById('mDesc');
    const contactIdInput = document.getElementById('mContactId');
    const activeDateInput = document.getElementById('dateInput');
    const slotKey = (slotInput?.value || 'morning').trim();
    const slot = global.HKPlannerUtils?.getPlannerSlotConfig
      ? global.HKPlannerUtils.getPlannerSlotConfig(slotKey)
      : { key: 'morning', label: '09:00–13:00', startTime: '09:00' };

    const priceLines = global.HKPlannerCatalogV1?.getModalCatalogLines
      ? global.HKPlannerCatalogV1.getModalCatalogLines()
      : [];
    const autoTotalPrice = roundPrice(priceLines.reduce((sum, row) => sum + Number(row.price || 0), 0));
    const totalPrice =
      totalPriceManual && Number.isFinite(Number(totalPriceManualValue))
        ? roundPrice(totalPriceManualValue)
        : autoTotalPrice;

    return {
      date:
        dateInput?.value ||
        activeDateInput?.value ||
        new Date().toISOString().split('T')[0],
      slotKey,
      slotLabel: slot.label,
      time: slot.startTime,
      type: (typeInput?.value || 'reparatie').trim().toLowerCase(),
      name: (nameInput?.value || '').trim(),
      address: (addressInput?.value || '').trim(),
      phone: (phoneInput?.value || '').trim(),
      email: (emailInput?.value || '').trim().toLowerCase(),
      desc: (descInput?.value || '').trim(),
      contactId: (contactIdInput?.value || '').trim(),
      priceLines,
      totalPrice,
      totalPriceAuto: autoTotalPrice,
      totalPriceManual,
    };
  }

  function validateInput(form) {
    if (!form.name) return 'Vul naam in';
    if (!form.address) return 'Vul adres in';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return 'Vul een geldige datum in';
    if (!/^\d{2}:\d{2}$/.test(form.time)) return 'Vul een geldige tijd in';
    if (!global.HKPlannerUtils?.getPlannerSlotConfig) return 'Tijdslot helper niet geladen';
    if (!Number.isFinite(form.totalPrice) || form.totalPrice < 0) return 'Prijs moet 0 of hoger zijn';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      return 'Vul een geldig e-mailadres in';
    }
    return null;
  }

  function updatePricePreview() {
    const totalInput = document.getElementById('mPrice');
    if (!totalInput) return;
    if (totalPriceManual && Number.isFinite(Number(totalPriceManualValue))) {
      totalInput.value = String(roundPrice(totalPriceManualValue));
      updateManualHint();
      return;
    }
    totalInput.value = String(readAutoTotalFromPriceLines());
    updateManualHint();
  }

  function onTotalPriceInput(rawValue) {
    const parsed = parseManualPriceInput(rawValue);
    if (parsed.empty) {
      totalPriceManual = false;
      totalPriceManualValue = null;
      updatePricePreview();
      return;
    }
    if (parsed.invalid) return;
    totalPriceManual = true;
    totalPriceManualValue = parsed.value;
    updateManualHint();
  }

  function resetTotalPriceOverride() {
    totalPriceManual = false;
    totalPriceManualValue = null;
    updatePricePreview();
  }

  function resetManualAppointmentForm(input = {}) {
    const dateYmd = String(input?.dateYmd || '').trim();
    const dateInput = document.getElementById('mDate');
    const slotInput = document.getElementById('mSlot');
    const typeInput = document.getElementById('mType');
    const nameInput = document.getElementById('mName');
    const addressInput = document.getElementById('mAddress');
    const phoneInput = document.getElementById('mPhone');
    const emailInput = document.getElementById('mEmail');
    const descInput = document.getElementById('mDesc');
    const contactIdInput = document.getElementById('mContactId');
    const modalPinTypeInput = document.getElementById('modalInternalFixedType');
    const modalPinTimeInput = document.getElementById('modalInternalFixedStart');
    const activeDateInput = document.getElementById('dateInput');

    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (emailInput) emailInput.value = '';
    if (addressInput) addressInput.value = '';
    if (descInput) descInput.value = '';
    if (contactIdInput) contactIdInput.value = '';
    if (modalPinTypeInput) modalPinTypeInput.value = '';
    if (modalPinTimeInput) modalPinTimeInput.value = '';
    if (typeof global.syncModalInternalFixedControls === 'function') {
      global.syncModalInternalFixedControls();
    }

    if (typeInput) {
      typeInput.selectedIndex = 0;
      if (!typeInput.value && typeInput.options.length > 0) typeInput.value = typeInput.options[0].value;
    }

    if (dateInput) {
      dateInput.value = dateYmd || activeDateInput?.value || new Date().toISOString().split('T')[0];
    }

    if (slotInput) {
      // Geen "hangen" in vorige keuze: eerst leeg, daarna default eerste optie als fallback.
      slotInput.value = '';
      if (!slotInput.value && slotInput.options.length > 0) slotInput.selectedIndex = 0;
    }

    totalPriceManual = false;
    totalPriceManualValue = null;
    editingMeta = null;
    setModalUiMode('create');
    const overlayReset = document.getElementById('modalOverlay');
    if (overlayReset) {
      delete overlayReset.dataset.hkEditContactId;
      delete overlayReset.dataset.hkEditPrevDate;
      delete overlayReset.dataset.hkEditPrevSlot;
      delete overlayReset.dataset.hkEditApptId;
    }

    if (global.HKPlannerCatalogV1?.resetModal) {
      global.HKPlannerCatalogV1.resetModal();
    } else if (global.HKPlannerCatalogV1?.clearModalCatalogLines) {
      global.HKPlannerCatalogV1.clearModalCatalogLines();
      global.HKPlannerCatalogV1.closeModalDropdown?.('form_reset');
    }

    updatePricePreview();
  }

  function syncTotalPriceModeFromExisting(input = {}) {
    const backendTotalRaw =
      input.backendTotal !== undefined ? input.backendTotal : document.getElementById('mPrice')?.value;
    const backendParsed = parseManualPriceInput(backendTotalRaw);
    if (backendParsed.empty || backendParsed.invalid) {
      totalPriceManual = false;
      totalPriceManualValue = null;
      updatePricePreview();
      return { manual: false, backendTotal: null, linesTotal: readAutoTotalFromPriceLines() };
    }

    const linesTotal =
      input.priceLines !== undefined
        ? calcLinesTotal(input.priceLines)
        : readAutoTotalFromPriceLines();
    const backendTotal = roundPrice(backendParsed.value);
    const mismatch = Math.abs(backendTotal - linesTotal) >= 0.01;

    if (mismatch) {
      totalPriceManual = true;
      totalPriceManualValue = backendTotal;
    } else {
      totalPriceManual = false;
      totalPriceManualValue = null;
    }
    updatePricePreview();
    return { manual: totalPriceManual, backendTotal, linesTotal };
  }

  async function saveModal(ctx) {
    if (inFlight) return;
    const {
      showToast,
      hkAuthHeader,
      refreshGhlContactBaseUrl,
      loadAppointments,
      getCurrentDate,
      getDateStr,
      setCurrentDate,
      formatDate,
      closeModal,
    } = ctx;
    const modeAtSaveStart = modalMode;

    const form = collectFormValues();
    const validationError = validateInput(form);
    if (validationError) {
      showToast(validationError, 'info');
      return;
    }

    const overlay = document.getElementById('modalOverlay');
    const addrInputEl = document.getElementById('mAddress');
    const editMeta =
      editingMeta ||
      (overlay?.dataset?.hkEditContactId
        ? {
            contactId: String(overlay.dataset.hkEditContactId).trim(),
            prevDate: String(overlay.dataset.hkEditPrevDate || '').trim(),
            prevSlotKey: String(overlay.dataset.hkEditPrevSlot || 'morning').trim(),
          }
        : null);
    traceEditAddress('[save_address_input]', {
      modalMode,
      mAddressValue: addrInputEl ? String(addrInputEl.value || '').trim() : null,
      formAddress: form.address,
      editMetaFromMemory: !!editingMeta,
      editMetaFromDom: !!overlay?.dataset?.hkEditContactId,
      contactId: editMeta?.contactId || null,
    });

    const willUpdateExisting =
      Boolean(editMeta?.contactId) &&
      (modalMode === 'edit' || Boolean(overlay?.dataset?.hkEditContactId));

    const addBtn = document.getElementById('btnModalAddAppt');
    inFlight = true;
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = modeAtSaveStart === 'edit' ? '⏳ Opslaan...' : '⏳ Toevoegen...';
    }

    await refreshGhlContactBaseUrl();
    showToast(willUpdateExisting ? '⏳ Afspraak bijwerken...' : '⏳ Afspraak opslaan in GHL...', 'loading');
    debug('start', {
      date: form.date,
      slot: form.slotKey,
      slotLabel: form.slotLabel,
      time: form.time,
      type: form.type,
      hasContactId: !!form.contactId,
      hasEmail: !!form.email,
      hasPrice: form.totalPrice > 0,
    });

    try {
      let data = {};
      let res = null;
      if (willUpdateExisting) {
        const changedDateOrSlot =
          String(form.date) !== String(editMeta.prevDate) ||
          String(form.slotKey) !== String(editMeta.prevSlotKey);
        if (changedDateOrSlot) {
          const moveRes = await fetch('/api/ghl?action=rescheduleAppointment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
            body: JSON.stringify({
              contactId: editMeta.contactId,
              prevDate: editMeta.prevDate,
              newDate: form.date,
              newTime: form.time,
              slotKey: form.slotKey,
              slotLabel: form.slotLabel,
              newTimeWindow: form.slotLabel,
              type: form.type,
            }),
          });
          if (!moveRes.ok) {
            const moveData = await moveRes.json().catch(() => ({}));
            throw new Error(moveData.error || moveData.detail || `Verplaatsen mislukt (${moveRes.status})`);
          }
        }
        const updateBody = {
          contactId: editMeta.contactId,
          name: form.name,
          phone: form.phone,
          email: form.email || '',
          address: form.address,
          date: form.date,
          slotKey: form.slotKey,
          slotLabel: form.slotLabel,
          type: form.type,
          desc: form.desc || '—',
          price: form.totalPrice,
          priceLines: form.priceLines,
        };
        debug('edit_save_address_payload', {
          contactId: editMeta.contactId,
          address: form.address,
          date: form.date,
          slotKey: form.slotKey,
        });
        traceEditAddress('[payload]', { body: updateBody, json: JSON.stringify(updateBody) });
        console.log('[TRACE][payload]', JSON.stringify(updateBody));
        console.log('[TRACE][modal_input]', {
          addressInput: document.querySelector('#mAddress')?.value,
          modalMode,
          editingMeta,
        });
        res = await fetch('/api/ghl?action=updatePlannerBookingDetails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
          body: JSON.stringify(updateBody),
        });
        data = await res.json().catch(() => ({}));
      } else {
        const payload = {
          name: form.name,
          phone: form.phone,
          email: form.email || '',
          address: form.address,
          date: form.date,
          time: form.time,
          slotKey: form.slotKey,
          slotLabel: form.slotLabel,
          timeWindow: form.slotLabel,
          type: form.type,
          desc: form.desc || '—',
          contactId: form.contactId || '',
          price: form.totalPrice,
          priceLines: form.priceLines,
        };
        res = await fetch('/api/ghl?action=createAppointment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
          body: JSON.stringify(payload),
        });
        data = await res.json().catch(() => ({}));
      }
      debug('response', {
        status: res.status,
        ok: res.ok,
        success: !!data?.success,
        contactId: data?.contactId || null,
        appointmentId: data?.appointmentId || null,
        warning: data?.warning || null,
      });
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.detail || `Opslaan mislukt (${res.status})`);
      }
      const apptId = String(editMeta?.apptId || overlay?.dataset?.hkEditApptId || '').trim();
      if (apptId && typeof global.setAppointmentInternalFixedStart === 'function') {
        const pinType = document.getElementById(
          'modalInternalFixedType')?.value || '';
        const pinTime = document.getElementById(
          'modalInternalFixedStart')?.value || '';
        const pinValue = pinType && pinTime
          ? JSON.stringify({ type: pinType, time: pinTime })
          : '';
        global.setAppointmentInternalFixedStart(apptId, pinValue);
      }

      const targetDate = normalizeYmdToDate(form.date);
      if (targetDate) {
        setCurrentDate(targetDate);
        const dateInput = document.getElementById('dateInput');
        const dateLabel = document.getElementById('dateLabel');
        if (dateInput) dateInput.value = getDateStr(targetDate);
        if (dateLabel) dateLabel.textContent = formatDate(targetDate);
      }

      resetManualAppointmentForm({ dateYmd: getDateStr(getCurrentDate()) });
      closeModal();
      await loadAppointments(getCurrentDate());
      if (data.warning) {
        showToast(`✓ Contact opgeslagen, maar agenda-slot niet geplaatst: ${data.warning}`, 'info');
      } else {
        showToast(
          modeAtSaveStart === 'edit'
            ? '✓ Afspraak bijgewerkt en planner ververst'
            : '✓ Afspraak toegevoegd en planner ververst',
          'success'
        );
      }
      debug('reload_done', { routeDate: getDateStr(getCurrentDate()) });
    } catch (e) {
      showToast(`⚠ Afspraak toevoegen mislukt: ${e.message || e}`, 'info');
      debug('error', { message: String(e?.message || e) });
    } finally {
      inFlight = false;
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = modeAtSaveStart === 'edit' ? 'Wijzigingen opslaan' : 'Toevoegen';
      }
    }
  }

  function bindModalKeyboardSubmit() {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay || overlay.dataset.hkModalSubmitBound === '1') return;
    overlay.dataset.hkModalSubmitBound = '1';
    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      if (target && target.tagName === 'TEXTAREA') return;
      if (!overlay.classList.contains('visible')) return;
      e.preventDefault();
      if (typeof global.saveModal === 'function') global.saveModal();
    });
  }

  function bindPriceControls() {
    const totalInput = document.getElementById('mPrice');
    if (totalInput && totalInput.dataset.hkManualPriceBound !== '1') {
      totalInput.dataset.hkManualPriceBound = '1';
      totalInput.addEventListener('input', (e) => onTotalPriceInput(e?.target?.value));
      totalInput.addEventListener('change', (e) => onTotalPriceInput(e?.target?.value));
    }
    updatePricePreview();
  }

  function openForEdit(ctx, apptId) {
    const a = ctx?.findAppointmentById ? ctx.findAppointmentById(apptId) : null;
    if (!a || !a.contactId) {
      ctx?.showToast?.('Geen bewerkbare afspraak gevonden', 'info');
      return;
    }
    const activeDate = ctx?.getDateStr ? ctx.getDateStr(ctx.getCurrentDate()) : '';
    const slotKey = global.HKPlannerUtils?.inferPlannerSlotKey
      ? global.HKPlannerUtils.inferPlannerSlotKey({
          dayPart: a.dayPart,
          timeWindow: a.timeWindow,
          timeSlot: a.timeSlot,
        })
      : (a.dayPart === 0 ? 'morning' : 'afternoon');
    const slotCfg = global.HKPlannerUtils?.getPlannerSlotConfig
      ? global.HKPlannerUtils.getPlannerSlotConfig(slotKey)
      : { key: slotKey, label: slotKey === 'afternoon' ? '13:00–17:00' : '09:00–13:00' };
    const first = String(a.firstName || '').trim();
    const last = String(a.lastName || '').trim();
    const fullName = `${first} ${last}`.trim() || String(a.name || '').trim();
    const baseLineDesc = String(a.jobDescription || 'Werkzaamheden').trim();
    const lines = [];
    if (Number(a.price || 0) > 0) {
      lines.push({ desc: baseLineDesc || 'Werkzaamheden', price: Math.round(Number(a.price) * 100) / 100 });
    }
    for (const ex of Array.isArray(a.extras) ? a.extras : []) {
      const p = Number(ex?.price);
      const d = String(ex?.desc || '').trim();
      if (!d || !Number.isFinite(p) || p < 0) continue;
      lines.push({ desc: d, price: Math.round(p * 100) / 100 });
    }

    resetManualAppointmentForm({ dateYmd: activeDate });
    setModalUiMode('edit');
    editingMeta = {
      apptId: String(a.id || apptId),
      contactId: String(a.contactId),
      prevDate: activeDate,
      prevSlotKey: slotCfg.key || slotKey,
    };

    const overlayOpen = document.getElementById('modalOverlay');
    if (overlayOpen) {
      overlayOpen.dataset.hkEditContactId = String(a.contactId);
      overlayOpen.dataset.hkEditPrevDate = activeDate;
      overlayOpen.dataset.hkEditPrevSlot = String(slotCfg.key || slotKey);
      overlayOpen.dataset.hkEditApptId = String(a.id || apptId);
    }
    traceEditAddress('[open_address]', {
      apptId,
      contactId: a.contactId,
      fullAddressLine: String(a.fullAddressLine || a.address || '').trim(),
    });

    const dateInput = document.getElementById('mDate');
    const slotInput = document.getElementById('mSlot');
    const typeInput = document.getElementById('mType');
    const nameInput = document.getElementById('mName');
    const addressInput = document.getElementById('mAddress');
    const phoneInput = document.getElementById('mPhone');
    const emailInput = document.getElementById('mEmail');
    const descInput = document.getElementById('mDesc');
    const contactIdInput = document.getElementById('mContactId');
    if (dateInput) dateInput.value = activeDate;
    if (slotInput) slotInput.value = slotCfg.key || slotKey;
    if (typeInput) {
      const rawType = String(a.jobType || 'reparatie').trim().toLowerCase();
      const typeLabel = rawType ? `${rawType.charAt(0).toUpperCase()}${rawType.slice(1)}` : 'Reparatie';
      typeInput.value = typeLabel;
    }
    if (nameInput) nameInput.value = fullName;
    if (addressInput) addressInput.value = String(a.fullAddressLine || a.address || '').trim();
    if (phoneInput) phoneInput.value = String(a.phone || '').trim();
    if (emailInput) {
      const emailVal = String(a.email || a.contact?.email || '').trim().toLowerCase();
      emailInput.value = emailVal;
    }
    if (descInput) descInput.value = baseLineDesc;
    if (contactIdInput) contactIdInput.value = String(a.contactId || '');
    const pin = a.internalFixedPin ||
      (a.internalFixedStartTime
        ? { type: 'exact', time: a.internalFixedStartTime }
        : null);
    const typeEl = document.getElementById(
      'modalInternalFixedType');
    const timeEl = document.getElementById(
      'modalInternalFixedStart');
    if (typeEl) typeEl.value = pin?.type || '';
    if (timeEl) timeEl.value = pin?.time || '';
    if (typeof global.syncModalInternalFixedControls === 'function') {
      global.syncModalInternalFixedControls();
    }

    if (global.HKPlannerCatalogV1?.setModalLines) {
      global.HKPlannerCatalogV1.setModalLines(lines);
    }
    const backendTotal = Number(ctx?.calcTotalPrice ? ctx.calcTotalPrice(a) : 0);
    if (Number.isFinite(backendTotal) && backendTotal >= 0) {
      syncTotalPriceModeFromExisting({ backendTotal, priceLines: lines });
    } else {
      updatePricePreview();
    }
  }

  global.HKPlannerManualAppointment = {
    saveModal,
    bindModalKeyboardSubmit,
    bindPriceControls,
    updatePricePreview,
    resetTotalPriceOverride,
    resetManualAppointmentForm,
    syncTotalPriceModeFromExisting,
    openForEdit,
  };
})(window);
