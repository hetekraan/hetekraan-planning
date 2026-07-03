/**
 * Klant-boekingen: halve dagen 09–13 / 13–17, max aantallen + geplande minuten.
 * GHL-agenda: zelfde vaste klantduur als gepland — geen “hele blok”-event.
 * Rijtijd zit in de route-optimizer, niet in deze minuten.
 */

export const BLOCK_PLANNED_MINUTES_TOTAL = 240;

/** Vaste klantduur (exclusief rijden) voor alle werktypes bij nieuwe boekingen. */
export const DEFAULT_APPOINTMENT_MINUTES = 50;

/** Max aantal klant-boekingen per blok (jij kunt in GHL nog handmatig bijboeken). */
export const CUSTOMER_MAX_PER_BLOCK = { morning: 4, afternoon: 3 };

export function normalizeWorkType(t) {
  const s = String(t || '').trim().toLowerCase();
  if (!s) return 'reparatie';
  if (s.includes('install')) return 'installatie';
  if (s.includes('onderhoud')) return 'onderhoud';
  if (s.includes('herafspraak') || s.includes('heraf')) return 'herafspraak';
  if (s.includes('repar')) return 'reparatie';
  return 'reparatie';
}

export function plannedMinutesForType(_type) {
  return DEFAULT_APPOINTMENT_MINUTES;
}

export function ghlDurationMinutesForType(_type) {
  return DEFAULT_APPOINTMENT_MINUTES;
}

export function customerMaxForBlock(block) {
  return block === 'morning' ? CUSTOMER_MAX_PER_BLOCK.morning : CUSTOMER_MAX_PER_BLOCK.afternoon;
}

/**
 * Geplande minuten voor een bestaand kalender-item (capaciteitstelling).
 * Gebruik de echte GHL end−start als die bekend is; anders DEFAULT_APPOINTMENT_MINUTES.
 */
export function plannedMinutesForExistingEvent(event) {
  const start = event?.startTime ? new Date(event.startTime).getTime() : NaN;
  const end = event?.endTime ? new Date(event.endTime).getTime() : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const m = Math.round((end - start) / 60000);
    if (m > 0) return m;
  }
  return DEFAULT_APPOINTMENT_MINUTES;
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
