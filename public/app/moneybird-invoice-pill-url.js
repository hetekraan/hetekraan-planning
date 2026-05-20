/* Sync met lib/moneybird-invoice-pill-url.js (planner index.html gebruikt global). */
(function initMoneybirdInvoicePillUrl(global) {
  function extractMoneybirdInvoicePillUrl(text) {
    const raw = String(text || '');
    const block = raw.match(/\[moneybird\][^\n\r]*/i);
    if (!block) return '';
    const um = block[0].match(/\burl=(\S+)/i);
    if (um && um[1]) return um[1].trim().replace(/[,;)\]}>'"]+$/, '');
    return '';
  }
  global.extractMoneybirdInvoicePillUrl = extractMoneybirdInvoicePillUrl;
})(typeof globalThis !== 'undefined' ? globalThis : window);
