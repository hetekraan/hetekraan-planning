// Dagelijkse cron job: zet tag ochtend-melding → GHL-workflow stuurt WhatsApp.
// Draait volgens vercel.json (bijv. 06:00 UTC).

import { amsterdamCalendarDayBoundsMs, formatYyyyMmDdInAmsterdam } from '../../lib/amsterdam-calendar-day.js';
import { fetchWithRetry } from '../../lib/retry.js';
import { sendErrorNotification } from '../../lib/notify.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-04-15',
  'Content-Type': 'application/json',
};

const GEPLANDE_AANKOMSTTIJD_FIELD = 'XELcOSdWq3tqRtpLE5x8';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel stuurt Authorization: Bearer <CRON_SECRET> bij scheduled invocations.
  // Als CRON_SECRET is ingesteld, moet het kloppen; zo niet → endpoint is open (dev-gebruik).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const dryRun = req.query?.dryRun === 'true';
  // Alleen écht tags zetten als dit aan staat (voorkomt per ongeluk ochtend-tags tijdens testen)
  const enabled = process.env.MORNING_MESSAGES_ENABLED === 'true';

  if (!enabled && !dryRun) {
    return res.status(200).json({
      sent: 0,
      skipped: true,
      message: 'Ochtend-cron uit. Zet MORNING_MESSAGES_ENABLED=true in Vercel om dagelijks ochtend-melding te zetten.',
    });
  }

  const today = formatYyyyMmDdInAmsterdam(new Date());
  if (!today) {
    return res.status(500).json({ error: 'Kon vandaag niet bepalen (tijdzone)' });
  }
  const bounds = amsterdamCalendarDayBoundsMs(today);
  if (!bounds) {
    return res.status(500).json({ error: 'Ongeldige dag voor agenda-query' });
  }
  const { startMs, endMs } = bounds;

  console.log(`[morning-messages] ${dryRun ? 'DRY RUN' : 'LIVE'} — ${today}`);

  try {
    const calRes = await fetchWithRetry(
      `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`,
      { headers: GHL_HEADERS }
    );
    const calData = await calRes.json();
    const events  = calData?.events || [];

    if (events.length === 0) {
      return res.status(200).json({ sent: 0, message: 'Geen afspraken vandaag' });
    }

    let sent = 0;
    const errors = [];
    const preview = [];

    for (const event of events) {
      if (!event.contactId) continue;

      try {
        let plannedTime = null;
        let contactData = null;

        const contactRes = await fetchWithRetry(
          `${GHL_BASE}/contacts/${event.contactId}`,
          { headers: GHL_HEADERS }
        );
        if (contactRes.ok) {
          contactData = await contactRes.json();
          const field = (contactData?.contact?.customFields || [])
            .find(f => f.id === GEPLANDE_AANKOMSTTIJD_FIELD);
          plannedTime = field?.value || null;
        }

        if (plannedTime) plannedTime = plannedTime.trim();
        if (plannedTime && /^\d{1,2}:\d{2}$/.test(plannedTime) && plannedTime !== '09:00') {
          const [h, m] = plannedTime.split(':').map(Number);
          const total = h * 60 + m;
          const fmt = min => `${String(Math.floor(Math.max(0, min) / 60)).padStart(2,'0')}:${String(Math.max(0, min) % 60).padStart(2,'0')}`;
          plannedTime = `${fmt(total - 60)}-${fmt(total + 60)}`;
        }

        if (!plannedTime) {
          const rawTime = new Date(event.startTime).toLocaleTimeString('nl-NL', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
          });
          if (rawTime === '09:00') {
            plannedTime = rawTime;
          } else {
            const [h, m] = rawTime.split(':').map(Number);
            const total = h * 60 + m;
            const fmt = min => `${String(Math.floor(Math.max(0,min)/60)).padStart(2,'0')}:${String(Math.max(0,min)%60).padStart(2,'0')}`;
            plannedTime = `${fmt(total - 60)}-${fmt(total + 60)}`;
          }
        }

        await fetchWithRetry(`${GHL_BASE}/contacts/${event.contactId}`, {
          method: 'PUT',
          headers: GHL_HEADERS,
          body: JSON.stringify({
            customFields: [{ id: GEPLANDE_AANKOMSTTIJD_FIELD, field_value: plannedTime }]
          }),
        });

        const contactName = contactData?.contact
          ? `${contactData.contact.firstName || ''} ${contactData.contact.lastName || ''}`.trim()
          : event.contactId;

        if (dryRun) {
          sent++;
          preview.push({ naam: contactName, tijd: plannedTime });
          console.log(`[morning-messages] DRY RUN – ${contactName} – ${plannedTime}`);
        } else {
          const tagRes = await fetchWithRetry(`${GHL_BASE}/contacts/${event.contactId}/tags`, {
            method: 'POST',
            headers: GHL_HEADERS,
            body: JSON.stringify({ tags: ['ochtend-melding'] }),
          });

          if (!tagRes.ok) {
            const err = await tagRes.text();
            errors.push(`${event.contactId}: ${tagRes.status} ${err}`);
          } else {
            sent++;
            console.log(`[morning-messages] Tag ochtend-melding → ${event.contactId}`);
          }
        }
      } catch (err) {
        errors.push(`${event.contactId}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      await sendErrorNotification('Ochtendmeldingen: fouten', errors.join('\n'));
    }

    return res.status(200).json({
      sent,
      total: events.length,
      errors,
      dryRun,
      ...(dryRun ? { preview } : {}),
    });

  } catch (err) {
    console.error('[morning-messages]', err.message);
    await sendErrorNotification('Ochtendmelding cron mislukt', err.message);
    return res.status(500).json({ error: err.message });
  }
}
