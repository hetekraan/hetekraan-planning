(function initCustomerSnapshotModal(global) {
  let currentSnapshotId = null;
  let currentContactId = null;
  let bound = false;
  let inFlight = false;

  function authHeader() {
    if (typeof global.hkAuthHeader === 'function') return global.hkAuthHeader();
    return (
      global.HKPlannerAuthSession?.hkAuthHeader?.({
        localStorageImpl: global.localStorage,
        documentRef: document,
      }) || ''
    );
  }

  function toast(msg, type) {
    if (typeof global.showToast === 'function') global.showToast(msg, type || 'info');
  }

  function overlayEl() {
    return document.getElementById('hkSnapModalOverlay');
  }

  function open(snapshot, opts) {
    const snap = snapshot || {};
    const overlay = overlayEl();
    if (!overlay) return;
    currentSnapshotId = snap.snapshotId || null;
    currentContactId = (opts && opts.contactId) || null;
    if (!currentSnapshotId) {
      toast('Geen snapshot-id — bewerken niet mogelijk', 'info');
      return;
    }
    const typeSel = document.getElementById('hkSnapType');
    const descEl = document.getElementById('hkSnapDesc');
    if (typeSel) typeSel.value = String(snap.type || 'reparatie').toLowerCase();
    if (descEl) descEl.value = String(snap.desc || '');
    bind();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    if (descEl && typeof descEl.focus === 'function') {
      try { descEl.focus(); } catch (_) {}
    }
  }

  function close() {
    const overlay = overlayEl();
    if (overlay) {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    currentSnapshotId = null;
    currentContactId = null;
  }

  async function save() {
    if (inFlight || !currentSnapshotId) return;
    const typeSel = document.getElementById('hkSnapType');
    const descEl = document.getElementById('hkSnapDesc');
    const body = {
      appointment_desc: String(descEl?.value || '').trim(),
      type: String(typeSel?.value || '').trim().toLowerCase(),
    };
    const cid = currentContactId;
    inFlight = true;
    toast('⏳ Wijziging opslaan…', 'loading');
    try {
      const res = await fetch(`/api/snapshot?snapshot_id=${encodeURIComponent(currentSnapshotId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Opslaan mislukt (${res.status})`);
      }
      close();
      toast('✓ Afspraak bijgewerkt', 'success');
      if (cid) {
        global.dispatchEvent(
          new CustomEvent('hk:customer-appointment-updated', { detail: { contactId: cid } })
        );
      }
    } catch (err) {
      toast(`⚠ Opslaan mislukt: ${err.message || err}`, 'info');
    } finally {
      inFlight = false;
    }
  }

  async function del() {
    if (inFlight || !currentSnapshotId) return;
    if (!global.confirm('Weet je zeker dat je deze afgeronde afspraak wil verwijderen?')) return;
    const cid = currentContactId;
    inFlight = true;
    toast('⏳ Afspraak verwijderen…', 'loading');
    try {
      const res = await fetch(`/api/snapshot?snapshot_id=${encodeURIComponent(currentSnapshotId)}`, {
        method: 'DELETE',
        headers: { 'X-HK-Auth': authHeader() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.detail || `Verwijderen mislukt (${res.status})`);
      }
      close();
      toast('✓ Afspraak verwijderd', 'success');
      if (cid) {
        global.dispatchEvent(
          new CustomEvent('hk:customer-appointment-deleted', { detail: { contactId: cid } })
        );
      }
    } catch (err) {
      toast(`⚠ Verwijderen mislukt: ${err.message || err}`, 'info');
    } finally {
      inFlight = false;
    }
  }

  function onOverlayClick(e) {
    if (e.target.closest('[data-action="snap-close"]')) return close();
    if (e.target.closest('[data-action="snap-save"]')) return void save();
    if (e.target.closest('[data-action="snap-delete"]')) return void del();
    // Klik op de donkere overlay-achtergrond sluit de modal.
    if (e.target === overlayEl()) return close();
  }

  function bind() {
    if (bound) return;
    const overlay = overlayEl();
    if (!overlay) return;
    overlay.addEventListener('click', onOverlayClick);
    bound = true;
  }

  global.HKPlannerCustomerSnapshotModal = { open, close, save, delete: del };
})(window);
