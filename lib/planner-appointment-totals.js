export function calcAppointmentTotal(appointment) {
  const baseRaw = Number(appointment?.price);
  const base = Number.isFinite(baseRaw) ? baseRaw : 0;
  const extrasTotal = (appointment?.extras || []).reduce((sum, extra) => {
    const p = Number(extra?.price);
    return sum + (Number.isFinite(p) ? p : 0);
  }, 0);
  return Math.round((base + extrasTotal) * 100) / 100;
}
