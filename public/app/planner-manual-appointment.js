(function initPlannerManualAppointment(global) {
  let inFlight = false;
  const SLOT_MAP = {
    morning: { label: '09:00–13:00', startTime: '09:00' },
    afternoon: { label: '13:00–17:00', startTime: '13:00' },
  };
  const BASE_PRICE_COMPONENTS = [
    { key: 'onderhoud', amount: 195, checkboxId: 'mPriceOnderhoud' },
    { key: 'voorrijkosten', amount: 50, checkboxId: 'mPriceVoorrijkosten' },
  ];

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
    const m = String(ymd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  }

  function collectFormValues() {
    const dateInput = document.getElementById('mDate');
    const slotInput = document.getElementById('mSlot');
    const typeInput = document.getElementById('mType');
    const nameInput = document.getElementById('mName');
    const addressInput = document.getElementById('mAddress');
    const phoneInput = document.getElementById('mPhone');
    const descInput = document.getElementById('mDesc');
    const contactIdInput = document.getElementById('mContactId');
    const activeDateInput = document.getElementById('dateInput');
    const extraDescInput = document.getElementById('mPriceExtraDesc');
    const extraAmountInput = document.getElementById('mPriceExtraAmount');
    const slotKey = (slotInput?.value || 'morning').trim();
    const slot = SLOT_MAP[slotKey] || SLOT_MAP.morning;

    const priceLines = [];
    for (const item of BASE_PRICE_COMPONENTS) {
      const checked = !!document.getElementById(item.checkboxId)?.checked;
      if (!checked) continue;
      priceLines.push({ desc: item.key, price: item.amount });
    }
    const extraDesc = (extraDescInput?.value || '').trim();
    const extraAmountRaw = Number(extraAmountInput?.value || 0);
    const extraAmount = Number.isFinite(extraAmountRaw) ? Math.round(extraAmountRaw * 100) / 100 : 0;
    if (extraDesc && extraAmount > 0) {
      priceLines.push({ desc: extraDesc, price: extraAmount });
    }
    const totalPrice = Math.round(priceLines.reduce((sum, row) => sum + Number(row.price || 0), 0) * 100) / 100;

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
      desc: (descInput?.value || '').trim(),
      contactId: (contactIdInput?.value || '').trim(),
      priceLines,
      totalPrice,
    };
  }

  function validateInput(form) {
    if (!form.name) return 'Vul naam in';
    if (!form.address) return 'Vul adres in';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return 'Vul een geldige datum in';
    if (!/^\d{2}:\d{2}$/.test(form.time)) return 'Vul een geldige tijd in';
    if (!SLOT_MAP[form.slotKey]) return 'Kies een geldig tijdslot';
    if (!Number.isFinite(form.totalPrice) || form.totalPrice < 0) return 'Prijs moet 0 of hoger zijn';
    return null;
  }

  function updatePricePreview() {
    const totalInput = document.getElementById('mPrice');
    if (!totalInput) return;
    const form = collectFormValues();
    totalInput.value = String(form.totalPrice || 0);
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
      hasPrice: form.totalPrice > 0,
    });

    try {
      const payload = {
        name: form.name,
        phone: form.phone,
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
    if (document.body?.dataset.hkModalPriceBound === '1') return;
    document.body.dataset.hkModalPriceBound = '1';
    const ids = ['mPriceOnderhoud', 'mPriceVoorrijkosten', 'mPriceExtraDesc', 'mPriceExtraAmount'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const evt = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number') ? 'input' : 'change';
      el.addEventListener(evt, updatePricePreview);
    }
    updatePricePreview();
  }

  global.HKPlannerManualAppointment = {
    saveModal,
    bindModalKeyboardSubmit,
    bindPriceControls,
    updatePricePreview,
  };
})(window);
