/**
 * Weekdag-cron: automatische ochtendmeldingen om 08:00 Amsterdam.
 *
 * vercel.json: "0 6 * * 1-5" = ma–vr 06:00 UTC.
 * ≈ 08:00 Europe/Amsterdam tijdens CEST (UTC+2, zomer).
 * Tijdens CET (UTC+1, winter) is dit 07:00 lokaal — DST-switch handmatig in herfst.
 */

import { formatYyyyMmDdInAmsterdam } from '../../lib/amsterdam-calendar-day.js';
import { ghlLocationIdFromEnv } from '../../lib/ghl-env-ids.js';
import { runMorningMessagesForDay, isWeekendDateStr } from '../../lib/morning-message-run.js';
import { loadPlannerAppointmentsForDate } from '../ghl.js';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GEPLANDE_AANKOMST_FIELD = 'XELcOSdWq3tqRtpLE5x8';

function locationIdsFromEnv() {
  const multi = String(process.env.GHL_LOCATION_IDS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = ghlLocationIdFromEnv();
  return single ? [single] : [];
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const today = formatYyyyMmDdInAmsterdam(new Date());
  if (!today) {
    return res.status(500).json({ error: 'Kon vandaag niet bepalen (tijdzone)' });
  }

  if (isWeekendDateStr(today)) {
    return res.status(200).json({ ok: true, skipped: true, code: 'WEEKEND', dateStr: today });
  }

  const locations = locationIdsFromEnv();
  if (!locations.length) {
    return res.status(500).json({ error: 'Geen GHL_LOCATION_ID geconfigureerd' });
  }

  const results = [];
  for (const locationId of locations) {
    try {
      const out = await runMorningMessagesForDay({
        locationId,
        dateStr: today,
        by: 'auto_cron',
        skipIfAlreadySent: true,
        skipEnabledCheck: false,
        loadAppointmentsForDate: (d) => loadPlannerAppointmentsForDate(d),
        sendDeps: {
          apiKey: GHL_API_KEY,
          geplandeAankomstFieldId: GEPLANDE_AANKOMST_FIELD,
        },
      });
      results.push({ locationId, ...out });
    } catch (err) {
      console.warn(
        'morning_messages_cron_location_failed',
        JSON.stringify({ locationId, dateStr: today, error: err?.message || String(err) })
      );
      results.push({
        locationId,
        ok: false,
        code: 'EXCEPTION',
        error: err?.message || String(err),
      });
    }
  }

  const failed = results.filter((r) => !r.ok && !r.skipped);
  return res.status(failed.length ? 207 : 200).json({
    ok: failed.length === 0,
    dateStr: today,
    results,
  });
}
