/**
 * GHL location + calendar uit env (Vercel). Geen hardcoded fallbacks — oude IDs na verwijderde kalender leiden tot stille fouten.
 */

export function stripGhlEnvId(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

export function ghlLocationIdFromEnv() {
  return stripGhlEnvId(process.env.GHL_LOCATION_ID) || '';
}

export function ghlCalendarIdFromEnv() {
  return stripGhlEnvId(process.env.GHL_CALENDAR_ID) || '';
}

/** Fouttekst voor APIs (Nederlands, kort). */
export const GHL_CONFIG_MISSING_MSG =
  'GHL is niet gekoppeld: zet GHL_API_KEY, GHL_LOCATION_ID en GHL_CALENDAR_ID in Vercel (Environment Variables). IDs vind je in GHL na het aanmaken van de kalender.';
