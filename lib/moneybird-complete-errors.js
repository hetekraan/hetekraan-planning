const EMAIL_UNREACHABLE_MSG =
  'Email-adres van klant kan geen berichten ontvangen. Controleer het emailadres in GHL en probeer opnieuw.';

const GENERIC_MSG =
  'Moneybird kon de factuur niet aanmaken. Controleer de gegevens en probeer het opnieuw.';

function joinRaw(...parts) {
  return parts
    .filter((p) => p != null && String(p).trim() !== '')
    .map(String)
    .join('\n');
}

/** @param {string} rawText */
export function userFacingMoneybirdErrorMessage(rawText) {
  const low = String(rawText || '').toLowerCase();
  if (low.includes('email_domain_unreachable')) {
    return EMAIL_UNREACHABLE_MSG;
  }
  return GENERIC_MSG;
}

/** @param {unknown} err */
export function moneybirdExceptionResult(err) {
  const raw = joinRaw(
    err && typeof err === 'object' && 'message' in err ? err.message : null,
    err && typeof err === 'object' && 'details' in err
      ? typeof err.details === 'string'
        ? err.details
        : JSON.stringify(err.details || {})
      : ''
  );
  const rawStatus = err && typeof err === 'object' && 'status' in err ? err.status : null;
  const num = rawStatus != null ? Number(rawStatus) : NaN;
  return {
    skipped: false,
    error: true,
    reason: 'moneybird_exception',
    errorMessage: userFacingMoneybirdErrorMessage(raw),
    errorCode: Number.isFinite(num) ? num : null,
  };
}

/**
 * @param {null|{ reason?: string, errorStatus?: number|null, errorMessage?: string|null, errorDetails?: string|null }} mbContact
 */
export function moneybirdContactCreateFailureResult(mbContact) {
  const raw = joinRaw(mbContact?.errorMessage, mbContact?.errorDetails, mbContact?.reason);
  const st =
    mbContact && typeof mbContact === 'object' && mbContact.errorStatus != null
      ? Number(mbContact.errorStatus)
      : null;
  return {
    skipped: false,
    error: true,
    reason: 'moneybird_contact_create_failed',
    errorMessage: userFacingMoneybirdErrorMessage(raw),
    errorCode: Number.isFinite(st) ? st : null,
  };
}

/** @param {null|{ reason?: string, message?: string, status?: number|null }} created */
export function moneybirdInvoiceNotCreatedResult(created) {
  const raw = joinRaw(created?.reason, created?.message);
  const st =
    created && typeof created === 'object' && created.status != null ? Number(created.status) : null;
  return {
    skipped: false,
    error: true,
    reason: 'moneybird_invoice_not_created',
    errorMessage: userFacingMoneybirdErrorMessage(raw),
    errorCode: Number.isFinite(st) ? st : null,
  };
}
