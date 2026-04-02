/**
 * GHL location + calendar uit env (Vercel).
 *
 * Kalender-fallback vervangt vroegere hardcoded ID’s (o.a. HK_PLANNING_JERRY_CALENDAR_ID,
 * SUGGEST_CALENDAR_FALLBACK): vdZlb1g9Ii8tIdCwwXDx, vdZIb1g9Ii8tIdCwwXDx, vdZlb1g9Ii8tldCwwXDx.
 * Primair: zet altijd GHL_CALENDAR_ID in env; fallback alleen als env leeg is.
 */

export function stripGhlEnvId(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

/** Zelfde rol als vroeger HK_PLANNING_JERRY_CALENDAR_ID / SUGGEST_CALENDAR_FALLBACK. */
export const GHL_CALENDAR_ID_FALLBACK = 'yfKaXxKvbNvMaibmgxYQ';

export function ghlLocationIdFromEnv() {
  return stripGhlEnvId(process.env.GHL_LOCATION_ID) || '';
}

export function ghlCalendarIdFromEnv() {
  return stripGhlEnvId(process.env.GHL_CALENDAR_ID) || GHL_CALENDAR_ID_FALLBACK;
}

/** Fouttekst voor APIs (Nederlands, kort). */
export const GHL_CONFIG_MISSING_MSG =
  'GHL is niet gekoppeld: zet GHL_API_KEY, GHL_LOCATION_ID en GHL_CALENDAR_ID in Vercel (Environment Variables). IDs vind je in GHL na het aanmaken van de kalender.';
