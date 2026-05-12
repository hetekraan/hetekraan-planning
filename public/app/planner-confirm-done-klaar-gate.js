/**
 * Gedeelde regels voor wanneer een afspraak lokaal "klaar" mag na completeAppointment.
 * Geladen vóór planner-actions.js (zie index.html).
 */
(function initPlannerConfirmDoneGate(global) {
  function shouldMarkKlaarLocally({ hasContactId, ghlResponseOk, fetchErrored }) {
    if (!hasContactId) return false;
    if (fetchErrored) return false;
    return ghlResponseOk === true;
  }

  /**
   * @param {Record<string, unknown>|null} mb moneybird-object uit completeAppointment-response
   * @returns {string|null} korte info-toast; null als geen skip
   */
  function moneybirdSkippedUserMessage(mb) {
    if (!mb || mb.skipped !== true) return null;
    const r = String(mb.reason || '').trim();
    const map = {
      no_billable_lines:
        'Afronden gelukt zonder factuur: geen factureerbare regels (€0 of lege regels).',
      missing_contact: 'Afronden gelukt — geen Moneybird-contact; factuur niet aangemaakt.',
      invoice_not_created: 'Afronden gelukt — factuur in Moneybird niet aangemaakt.',
      already_linked: 'Afronden gelukt — factuur stond al gekoppeld in GHL.',
      reference_exists: 'Afronden gelukt — factuur met deze referentie bestond al.',
    };
    return map[r] || `Afronden gelukt — factuur overgeslagen (${r || 'onbekend'}).`;
  }

  global.HKPlannerConfirmDoneGate = {
    shouldMarkKlaarLocally,
    moneybirdSkippedUserMessage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
