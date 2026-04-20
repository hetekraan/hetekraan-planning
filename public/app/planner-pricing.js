(function initPlannerPricing(global) {
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const persistTimers = new Map();

  function calcTotalPrice(a) {
    const baseRaw = Number(a?.price);
    const base = Number.isFinite(baseRaw) ? baseRaw : 0;
    const extrasTotal = (a?.extras || []).reduce((s, e) => {
      const p = Number(e?.price);
      return s + (Number.isFinite(p) ? p : 0);
    }, 0);
    return Math.round((base + extrasTotal) * 100) / 100;
  }

  function persistTimerKey(a) {
    return `${String(a?.contactId || '').trim()}:${String(a?.id ?? '')}`;
  }

  /** Verwijdert exacte dubbele regels (zelfde omschrijving + bedrag) vóór opslaan. */
  function dedupePriceLines(lines) {
    const out = [];
    const seen = new Set();
    for (const row of lines) {
      const k = `${String(row.desc || '').trim().toLowerCase()}|${row.price}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    return out;
  }

  async function persistPriceLines({ appointment, authHeader }) {
    const a = appointment;
    if (!a || !a.contactId) return { ok: false, reason: 'missing_contact' };
    let lines = (a.extras || [])
      .map((e) => ({
        desc: String(e.desc || '').trim(),
        price: Math.round((Number(e.price) || 0) * 100) / 100,
      }))
      .filter((e) => e.desc && e.price > 0 && Number.isFinite(e.price));
    lines = dedupePriceLines(lines);
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
      try {
        console.info(
          '[planner] price_lines_saved',
          JSON.stringify({
            contactId: String(a.contactId),
            appointmentId: a.id != null ? String(a.id) : null,
            lineCount: lines.length,
            total,
          })
        );
        console.info(
          '[planner] price_total_recalculated',
          JSON.stringify({
            contactId: String(a.contactId),
            appointmentId: a.id != null ? String(a.id) : null,
            total,
            base: Number.isFinite(Number(a.price)) ? Number(a.price) : 0,
            extrasLines: lines.length,
          })
        );
      } catch (_) {}
      return { ok: true, total, lines };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Debounced GHL-persist zodat realtime typen op mobiel geen storm van requests doet
   * en geen full re-renders nodig heeft.
   */
  function debouncedPersistPriceLines({ appointment, authHeader, delayMs = 450 }) {
    const a = appointment;
    if (!a || !a.contactId) return;
    const key = persistTimerKey(a);
    const prev = persistTimers.get(key);
    if (prev) clearTimeout(prev);
    persistTimers.set(
      key,
      setTimeout(async () => {
        persistTimers.delete(key);
        const out = await persistPriceLines({ appointment: a, authHeader });
        if (!out.ok) {
          console.warn(
            '[planner] price_lines_save_failed',
            JSON.stringify({
              contactId: a.contactId,
              appointmentId: a.id,
              status: out.status,
              error: out.error || out.reason,
            })
          );
        }
      }, delayMs)
    );
  }

  /** Annuleert pending debounce en schrijft meteen (bijv. vóór completeAppointment). */
  async function flushDebouncedPersistPriceLines({ appointment, authHeader }) {
    const a = appointment;
    if (!a || !a.contactId) return { ok: true, skipped: true };
    const key = persistTimerKey(a);
    const prev = persistTimers.get(key);
    if (prev) {
      clearTimeout(prev);
      persistTimers.delete(key);
    }
    return persistPriceLines({ appointment: a, authHeader });
  }

  global.HKPlannerPricing = {
    calcTotalPrice,
    persistPriceLines,
    debouncedPersistPriceLines,
    flushDebouncedPersistPriceLines,
  };
})(window);
