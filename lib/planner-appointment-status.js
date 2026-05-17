/**
 * Gedeelde planner-status: één bron voor ochtendmeldingen en UI-filters.
 */

function cleanString(value) {
  return String(value ?? '').trim();
}

/** Normaliseer status uit appointment-object (server + client). */
export function resolvePlannerAppointmentStatus(appt) {
  return cleanString(appt?.status || appt?.appointmentStatus).toLowerCase();
}

/**
 * Afspraak komt in aanmerking voor ochtendmelding: te doen op de route-dag.
 * Sluit klaar, onderweg en geannuleerde varianten uit.
 */
export function isPlannerAppointmentEligibleForMorningMessage(appt) {
  if (!appt?.contactId || appt.isCalBlock) return false;
  const st = resolvePlannerAppointmentStatus(appt);
  if (!st) return true;
  if (st === 'klaar' || st === 'onderweg') return false;
  if (/cancel|annul|no.?show|afgewezen|mislukt/.test(st)) return false;
  return true;
}

export function countMorningEligibleAppointments(appointments) {
  return (Array.isArray(appointments) ? appointments : []).filter((a) =>
    isPlannerAppointmentEligibleForMorningMessage(a)
  ).length;
}
