/**
 * Normaliseert NL-telefoonnummers naar E.164 (+31…) voor GHL / WhatsApp.
 * GHL weigert of routeert soms niet als het nummer alleen "06…" is.
 */
export function normalizeNlPhone(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.startsWith('31') && s.length >= 11) return `+${s}`;
  if (s.startsWith('0')) return `+31${s.slice(1)}`;
  if (/^\d{9,}$/.test(s)) return `+${s}`;
  return s;
}
