(function () {
  let toastTimer;

  function showToast(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.style.whiteSpace = 'pre-line';
    toast.textContent = String(message || '');
    toast.className = `toast ${type || 'info'} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
  }

  function showPaymentLinkFallback(url, invoiceNumber, total) {
    const old = document.getElementById('paymentLinkFallback');
    if (old) old.remove();

    const safeUrl = String(url || '');
    const overlay = document.createElement('div');
    overlay.id = 'paymentLinkFallback';
    overlay.style.cssText = [
      'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999',
      'display:flex;align-items:center;justify-content:center;padding:24px',
    ].join(';');

    const totalStr = total != null ? `EUR ${Number(total).toFixed(2).replace('.', ',')}` : '';
    overlay.innerHTML = `
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:28px 24px;max-width:480px;width:100%;">
        <div style="font-size:18px;font-weight:700;color:#fff;margin-bottom:6px;">Klaar</div>
        <div style="font-size:14px;color:#f59e0b;margin-bottom:18px;">
          WhatsApp kon niet automatisch verstuurd worden via GHL.<br>
          Kopieer de link hieronder en stuur hem handmatig.
        </div>
        <div style="font-size:13px;color:#9a9a9a;margin-bottom:4px;">Factuur ${invoiceNumber || ''}${totalStr ? ' - ' + totalStr + ' incl. BTW' : ''}</div>
        <div style="display:flex;gap:8px;margin-bottom:20px;">
          <input id="payLinkInput" readonly value="${safeUrl}"
            style="flex:1;background:#111;border:1px solid #333;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;min-width:0;" />
          <button id="payLinkCopyBtn"
            style="background:#ffd000;color:#000;font-weight:700;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;white-space:nowrap;">
            Kopieer
          </button>
        </div>
        <button id="payLinkCloseBtn"
          style="width:100%;background:#272727;border:none;border-radius:8px;padding:11px;color:#f0f0f0;font-size:14px;cursor:pointer;">
          Sluiten
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    const copyBtn = document.getElementById('payLinkCopyBtn');
    const closeBtn = document.getElementById('payLinkCloseBtn');
    const input = document.getElementById('payLinkInput');

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(safeUrl);
          copyBtn.textContent = 'OK';
          setTimeout(() => {
            copyBtn.textContent = 'Kopieer';
          }, 1500);
        } catch (_) {
          if (input) {
            input.select();
            document.execCommand('copy');
          }
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const node = document.getElementById('paymentLinkFallback');
        if (node) node.remove();
      });
    }
  }

  window.HKPlannerFeedbackUi = {
    showToast,
    showPaymentLinkFallback,
  };
})();
