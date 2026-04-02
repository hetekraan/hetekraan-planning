/**
 * GHL location + calendar uit env (Vercel).
 *
 * Kalender: op Vercel production is GHL_CALENDAR_ID verplicht (geen fallback).
 * Lokaal / preview / development: optioneel GHL_CALENDAR_ID_FALLBACK als env leeg is.
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
  const fromEnv = stripGhlEnvId(process.env.GHL_CALENDAR_ID);
  if (fromEnv) return fromEnv;
  if (process.env.VERCEL_ENV === 'production') return '';
  return GHL_CALENDAR_ID_FALLBACK;
}

/** Fouttekst voor APIs (Nederlands, kort). */
export const GHL_CONFIG_MISSING_MSG =
  'GHL is niet gekoppeld: zet GHL_API_KEY, GHL_LOCATION_ID en GHL_CALENDAR_ID in Vercel (Environment Variables). IDs vind je in GHL na het aanmaken van de kalender.';
