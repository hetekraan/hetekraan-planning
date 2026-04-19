(function initPlannerAdmin(global) {
  /**
   * Factuur op bedrijf (GHL → Moneybird): backend ondersteunt optionele velden op
   * `updateContactDashboard` (camelCase: factuurType, factuurBedrijfsnaam, factuurTav, …).
   * UI: uitbreiden `saveDaanEditToGhl` body + modal met dezelfde keys wanneer velden in GHL bestaan.
   * Zie `lib/invoice-party-ghl.js` → INVOICE_PARTY_GHL_FIELD_KEYS.
   */
  function syncInternalFixedControls() {
    const typeEl = document.getElementById('deInternalFixedType');
    const timeEl = document.getElementById('deInternalFixedStart');
    if (!timeEl) return;
    const enabled = !!(typeEl && typeEl.value);
    timeEl.disabled = !enabled;
    if (!enabled) timeEl.value = '';
  }

  function openDaanEditModal(ctx, apptId) {
    if (!ctx.isDaanEditor()) {
      ctx.showToast('Alleen Daan kan klantgegevens zo bewerken', 'info');
      return;
    }
    const a = ctx.findAppointmentById(apptId);
    if (!a || !a.contactId) {
      ctx.showToast('Geen GHL-contact op deze kaart', 'info');
      return;
    }
    document.getElementById('deApptId').value = String(apptId);
    document.getElementById('deFirstName').value = a.firstName || '';
    document.getElementById('deLastName').value = a.lastName || '';
    document.getElementById('dePhone').value = a.phone || '';
    document.getElementById('deStraat').value = a.straatnaam || '';
    document.getElementById('deHuisnr').value = a.huisnummer || '';
    document.getElementById('dePostcode').value = a.postalCode || '';
    document.getElementById('deWoonplaats').value = a.woonplaats || a.city || '';
    document.getElementById('deType').value =
      a.jobType === 'installatie' || a.jobType === 'reparatie' || a.jobType === 'onderhoud'
        ? a.jobType
        : 'onderhoud';
    document.getElementById('deDesc').value = a.jobDescription || '';
    document.getElementById('deTimeWindow').value = a.timeWindow || '';
    document.getElementById('deNotes').value = a.notes || '';
    const prijsTxt = a.priceLabel ? a.priceLabel.replace(/^€\s*/, '').trim() : a.price ? String(a.price) : '';
    document.getElementById('dePrijs').value = prijsTxt;
    const tm = ctx.normalizeTimeStr(a.timeSlot || '08:00');
    document.getElementById('deApptTime').value = tm.length >= 5 ? tm : '08:00';
    document.getElementById('deDuration').value = String(ctx.jobDurationForType(a.jobType));
    const pin = a.internalFixedPin || (a.internalFixedStartTime ? { type: 'exact', time: a.internalFixedStartTime } : null);
    const typeEl = document.getElementById(
      'deInternalFixedType');
    const timeEl = document.getElementById(
      'deInternalFixedStart');
    if (typeEl) typeEl.value = pin?.type || '';
    if (timeEl) timeEl.value = pin?.time || '';
    syncInternalFixedControls();
    document.getElementById('daanEditOverlay').classList.add('visible');
  }

  function closeDaanEditModal() {
    document.getElementById('daanEditOverlay').classList.remove('visible');
  }

  async function saveDaanEditToGhl(ctx) {
    if (!ctx.isDaanEditor()) return;
    const apptIdRaw = document.getElementById('deApptId').value;
    const a = ctx.findAppointmentById(apptIdRaw);
    if (!a || !a.contactId) return;
    const btn = document.getElementById('deSaveBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Opslaan...';
    const selType = document.getElementById('deType').value;
    const durVal = parseInt(document.getElementById('deDuration').value, 10);
    const body = {
      editedBy: 'daan',
      contactId: a.contactId,
      firstName: document.getElementById('deFirstName').value.trim(),
      lastName: document.getElementById('deLastName').value.trim(),
      phone: document.getElementById('dePhone').value.trim(),
      straatnaam: document.getElementById('deStraat').value.trim(),
      huisnummer: document.getElementById('deHuisnr').value.trim(),
      postcode: document.getElementById('dePostcode').value.trim(),
      woonplaats: document.getElementById('deWoonplaats').value.trim(),
      typeOnderhoud: selType,
      probleemomschrijving: document.getElementById('deDesc').value.trim(),
      tijdafspraak: document.getElementById('deTimeWindow').value.trim(),
      opmerkingen: document.getElementById('deNotes').value.trim(),
      prijs: document.getElementById('dePrijs').value.trim(),
      appointmentTime: document.getElementById('deApptTime').value,
      routeDate: ctx.getDateStr(ctx.getCurrentDate()),
      ghlAppointmentId: a.id || undefined,
      durationMin: Number.isFinite(durVal) && durVal > 0 ? durVal : ctx.jobDurationForType(selType),
    };
    try {
      const res = await fetch('/api/ghl?action=updateContactDashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': ctx.hkAuthHeader() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || 'Onbekende fout');
      closeDaanEditModal();
      let msg = '✓ Contact bijgewerkt in GHL';
      if (data.calendarSynced) msg += ' · agenda bijgewerkt';
      if (data.calendarError) msg += ' · agenda: ' + String(data.calendarError).slice(0, 100);
      ctx.showToast(msg, 'success');
      const pinType = document.getElementById(
        'deInternalFixedType')?.value || '';
      const pinTime = document.getElementById(
        'deInternalFixedStart')?.value || '';
      const pinValue = pinType && pinTime
        ? JSON.stringify({ type: pinType, time: pinTime })
        : '';
      setAppointmentInternalFixedStart(apptIdRaw, pinValue);
      await ctx.loadAppointments(ctx.getCurrentDate());
    } catch (e) {
      ctx.showToast('Opslaan mislukt: ' + e.message, 'info');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Opslaan in GHL';
    }
  }

  global.HKPlannerAdmin = {
    openDaanEditModal,
    closeDaanEditModal,
    saveDaanEditToGhl,
    syncInternalFixedControls,
  };
})(window);
