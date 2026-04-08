(function initPlannerPricing(global) {
  function calcTotalPrice(a) {
    const baseRaw = Number(a?.price);
    const base = Number.isFinite(baseRaw) ? baseRaw : 0;
    const extrasTotal = (a?.extras || []).reduce((s, e) => {
      const p = Number(e?.price);
      return s + (Number.isFinite(p) ? p : 0);
    }, 0);
    return Math.round((base + extrasTotal) * 100) / 100;
  }

  async function persistPriceLines({ appointment, authHeader }) {
    const a = appointment;
    if (!a || !a.contactId) return { ok: false, reason: 'missing_contact' };
    const lines = (a.extras || [])
      .map((e) => ({
        desc: String(e.desc || '').trim(),
        price: Math.round((Number(e.price) || 0) * 100) / 100,
      }))
      .filter((e) => e.desc && e.price > 0 && Number.isFinite(e.price));
    const total = calcTotalPrice(a);
    try {
      const res = await fetch('/api/ghl?action=updatePriceLines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HK-Auth': authHeader || '' },
        body: JSON.stringify({
          contactId: a.contactId,
          extras: lines,
          totalPrice: total,
        }),
      });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, total, lines };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  global.HKPlannerPricing = {
    calcTotalPrice,
    persistPriceLines,
  };
})(window);
