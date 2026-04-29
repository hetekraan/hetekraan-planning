// Publieke (niet-gevoelige) config voor het dashboard: alleen location-id voor GHL-contactlinks.
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';

/**
 * Optionele template om de GHL/Lead Connector **mobiele app** te openen i.p.v. alleen Safari.
 * Moet exact `{contactId}` bevatten (placeholder wordt vervangen door het GHL contact-id).
 * Voorbeeld (niet officieel gedocumenteerd door GHL — zet alleen na verificatie met support/app):
 *   GHL_IOS_CONTACT_APP_URL_TEMPLATE=leadconnector://contact/{contactId}
 */
function sanitizeGhlIosContactAppUrlTemplate(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 512) return '';
  if (!t.includes('{contactId}')) return '';
  const lower = t.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return '';
  return t;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ghlLocationId = ghlLocationIdFromEnv() || null;
  const ghlIosContactAppUrlTemplate = sanitizeGhlIosContactAppUrlTemplate(
    process.env.GHL_IOS_CONTACT_APP_URL_TEMPLATE || ''
  );
  const appVersion =
    String(
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.VERCEL_DEPLOYMENT_ID ||
      ''
    ).trim() || null;
  const googleMapsApiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim() || null;
  return res.status(200).json({
    ghlLocationId,
    /** Zonder location-id zijn contactlinks in het dashboard niet te bouwen. */
    ghlLinksOk: Boolean(ghlLocationId),
    /** Leeg tenzij GHL_IOS_CONTACT_APP_URL_TEMPLATE gezet is (mobiele app, zie sanitize-functie). */
    ghlIosContactAppUrlTemplate,
    /** Publieke browser key voor Google Maps JavaScript API in planner UI. */
    googleMapsApiKey,
    /** Publieke deployversie voor client-side update checks (homescreen stale-cache guard). */
    appVersion,
  });
}
