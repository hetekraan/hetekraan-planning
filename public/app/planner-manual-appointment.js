(function initPlannerManualAppointment(global) {
  let inFlight = false;
  let totalPriceManual = false;
  let totalPriceManualValue = null;

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

  function resetManualAppointmentForm() {
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

    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (emailInput) emailInput.value = '';
    if (addressInput) addressInput.value = '';
    if (descInput) descInput.value = '';
    if (contactIdInput) contactIdInput.value = '';

    if (typeInput) {
      typeInput.selectedIndex = 0;
      if (!typeInput.value && typeInput.options.length > 0) typeInput.value = typeInput.options[0].value;
    }

    if (dateInput) {
      dateInput.value =
        activeDateInput?.value ||
        new Date().toISOString().split('T')[0];
    }

    if (slotInput) {
      // Geen "hangen" in vorige keuze: eerst leeg, daarna default eerste optie als fallback.
      slotInput.value = '';
      if (!slotInput.value && slotInput.options.length > 0) slotInput.selectedIndex = 0;
    }

    totalPriceManual = false;
    totalPriceManualValue = null;

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

    const form = collectFormValues();
    const validationError = validateInput(form);
    if (validationError) {
      showToast(validationError, 'info');
      return;
    }

    const addBtn = document.getElementById('btnModalAddAppt');
    inFlight = true;
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = '⏳ Toevoegen...';
    }

    await refreshGhlContactBaseUrl();
    showToast('⏳ Afspraak opslaan in GHL...', 'loading');
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
      const res = await fetch('/api/ghl?action=createAppointment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': hkAuthHeader() },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
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

      const targetDate = normalizeYmdToDate(form.date);
      if (targetDate) {
        setCurrentDate(targetDate);
        const dateInput = document.getElementById('dateInput');
        const dateLabel = document.getElementById('dateLabel');
        if (dateInput) dateInput.value = getDateStr(targetDate);
        if (dateLabel) dateLabel.textContent = formatDate(targetDate);
      }

      resetManualAppointmentForm();
      closeModal();
      await loadAppointments(getCurrentDate());
      if (data.warning) {
        showToast(`✓ Contact opgeslagen, maar agenda-slot niet geplaatst: ${data.warning}`, 'info');
      } else {
        showToast('✓ Afspraak toegevoegd en planner ververst', 'success');
      }
      debug('reload_done', { routeDate: getDateStr(getCurrentDate()) });
    } catch (e) {
      showToast(`⚠ Afspraak toevoegen mislukt: ${e.message || e}`, 'info');
      debug('error', { message: String(e?.message || e) });
    } finally {
      inFlight = false;
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = 'Toevoegen';
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

  global.HKPlannerManualAppointment = {
    saveModal,
    bindModalKeyboardSubmit,
    bindPriceControls,
    updatePricePreview,
    resetTotalPriceOverride,
    resetManualAppointmentForm,
    syncTotalPriceModeFromExisting,
  };
})(window);
