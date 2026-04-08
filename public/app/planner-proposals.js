(function initPlannerProposals(global) {
  function buildPlannerProposalConstraints() {
    const c = {};
    if (document.getElementById('hkProposalFridaysOnly')?.checked) c.allowedWeekdays = [5];
    const datesRaw = document.getElementById('hkProposalSpecificDates')?.value?.trim();
    const datesOnlyMode = document.getElementById('hkProposalDatesOnlyMode')?.checked;
    if (datesRaw) {
      const dates = [
        ...new Set(
          datesRaw
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
        ),
      ];
      if (dates.length) {
        c.allowedDates = dates;
        if (datesOnlyMode) c.datesOnly = true;
      }
    }
    const excl = document.getElementById('hkProposalExcludeKeys')?.value?.trim();
    if (excl) {
      const keys = [...new Set(excl.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
      if (keys.length) c.excludedOfferKeys = keys;
    }
    const blockPart = document.getElementById('hkProposalBlockPart')?.value;
    if (blockPart === 'morning' || blockPart === 'afternoon') c.allowedBlocks = [blockPart];
    return Object.keys(c).length ? c : null;
  }

  async function sendBookingLink(ctx) {
    const name = document.getElementById('mName').value.trim();
    const phone = document.getElementById('mPhone').value.trim();
    const address = document.getElementById('mAddress').value.trim();
    const type = document.getElementById('mType').value.toLowerCase();
    const desc = document.getElementById('mDesc').value.trim();
    const date = document.getElementById('mDate')?.value || new Date().toISOString().split('T')[0];
    if (!name) {
      ctx.showToast('Vul de naam in', 'info');
      return;
    }
    if (!phone) {
      ctx.showToast('Vul het telefoonnummer in voor de boekingslink', 'info');
      return;
    }
    ctx.showToast('⏳ Boekingslink aanmaken...', 'loading');
    try {
      const proposalConstraints = buildPlannerProposalConstraints();
      const body = { name, phone, address, type, workType: type, desc };
      if (proposalConstraints) body.proposalConstraints = proposalConstraints;
      const res = await fetch('/api/send-booking-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || data.error || 'Fout');
      const bookingUrl = data.bookingUrl;
      try {
        await navigator.clipboard.writeText(bookingUrl);
        ctx.showToast(`✓ Link gekopieerd!\n${bookingUrl}`, 'success');
      } catch {
        ctx.showToast(`Boekingslink:\n${bookingUrl}`, 'success');
      }
      if (phone) {
        const cleanPhone = phone.replace(/[^0-9+]/g, '').replace(/^0/, '+31');
        const msg = encodeURIComponent(
          `Hallo ${name}! Je kunt hier je afspraak inplannen voor ${new Date(
            date + 'T12:00:00+01:00'
          ).toLocaleDateString('nl-NL', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}: ${bookingUrl}`
        );
        window.open(`https://wa.me/${cleanPhone}?text=${msg}`, '_blank');
      }
      ctx.closeModal();
    } catch (e) {
      ctx.showToast(`Fout: ${e.message}`, 'info');
    }
  }

  global.HKPlannerProposals = {
    buildPlannerProposalConstraints,
    sendBookingLink,
  };
})(window);
