/**
 * Gerichte availability-logs (correctheid). Zet HK_AVAILABILITY_DEBUG=1 of true in env.
 * Geen logs als uit — voorkomt ruis in productie.
 */

export function availabilityDebugEnabled() {
  const v = process.env.HK_AVAILABILITY_DEBUG;
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

/** Eén JSON-regel per call — makkelijk te greppen. */
export function logAvailability(event, payload) {
  if (!availabilityDebugEnabled()) return;
  const line = {
    ts: new Date().toISOString(),
    scope: 'hk-availability',
    event,
    ...payload,
  };
  console.log(JSON.stringify(line));
}
