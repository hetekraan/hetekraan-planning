/**
 * Moneybird factuur-pill in planner: alleen tonen als er een echte [moneybird]-marker
 * met url= op dezelfde regel staat (geen losse url= fallback).
 * @param {string} text
 * @returns {string} absolute URL of leeg
 */
export function extractMoneybirdInvoicePillUrl(text) {
  const raw = String(text || '');
  const block = raw.match(/\[moneybird\][^\n\r]*/i);
  if (!block) return '';
  const um = block[0].match(/\burl=(\S+)/i);
  if (um && um[1]) return um[1].trim().replace(/[,;)\]}>'"]+$/, '');
  return '';
}
