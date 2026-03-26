/**
 * Klant-boekingen: halve dagen 09–13 / 13–17, max aantallen + geplande minuten.
 * GHL-agenda:zelfde duur als gepland (45 / 60 / 90 min) — geen “hele blok”-event.
 */

export const BLOCK_PLANNED_MINUTES_TOTAL = 240;

/** Max aantal klant-boekingen per blok (jij kunt in GHL nog handmatig bijboeken). */
export const CUSTOMER_MAX_PER_BLOCK = { morning: 4, afternoon: 3 };

/** Geplande werktijd + duur van de kalender-afspraak in GHL (zelfde waarden). */
export const PLANNED_MINUTES = {
  onderhoud: 45,
  reparatie: 60,
  installatie: 90,
};

export const GHL_DURATION_MINUTES = { ...PLANNED_MINUTES };

export function normalizeWorkType(t) {
  const s = String(t || '').trim().toLowerCase();
  if (!s) return 'reparatie';
  if (s.includes('install')) return 'installatie';
  if (s.includes('onderhoud')) return 'onderhoud';
  if (s.includes('repar')) return 'reparatie';
  return 'reparatie';
}

export function plannedMinutesForType(type) {
  const k = normalizeWorkType(type);
  return PLANNED_MINUTES[k] ?? 60;
}

export function ghlDurationMinutesForType(type) {
  const k = normalizeWorkType(type);
  return GHL_DURATION_MINUTES[k] ?? 60;
}

export function customerMaxForBlock(block) {
  return block === 'morning' ? CUSTOMER_MAX_PER_BLOCK.morning : CUSTOMER_MAX_PER_BLOCK.afternoon;
}

/**
 * Geschatte geplande minuten voor een bestaand kalender-item (titel of duur in GHL).
 */
export function plannedMinutesForExistingEvent(event) {
  const title = String(event?.title || '');
  if (/install/i.test(title)) return PLANNED_MINUTES.installatie;
  if (/onderhoud/i.test(title)) return PLANNED_MINUTES.onderhoud;
  if (/repar/i.test(title)) return PLANNED_MINUTES.reparatie;
  const start = event?.startTime ? new Date(event.startTime).getTime() : NaN;
  const end = event?.endTime ? new Date(event.endTime).getTime() : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const m = Math.round((end - start) / 60000);
    if (m >= 75) return PLANNED_MINUTES.installatie;
    if (m >= 52) return PLANNED_MINUTES.reparatie;
    if (m >= 38) return PLANNED_MINUTES.onderhoud;
  }
  return PLANNED_MINUTES.reparatie;
}

export function blockPlannedMinutesUsed(blockEvents) {
  return blockEvents.reduce((sum, e) => sum + plannedMinutesForExistingEvent(e), 0);
}

/** Mag deze klant dit werkstype nog in dit blok boeken? */
export function blockAllowsNewCustomerBooking(block, blockEvents, workType) {
  const maxC = customerMaxForBlock(block);
  if (blockEvents.length >= maxC) return false;
  const used = blockPlannedMinutesUsed(blockEvents);
  const need = plannedMinutesForType(workType);
  return used + need <= BLOCK_PLANNED_MINUTES_TOTAL;
}
