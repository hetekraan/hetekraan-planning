// Email notificaties via GHL.
// Zoekt of maakt een contact aan voor info@hetekraan.nl
// en stuurt een email via de GHL conversations API.

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const NOTIFY_EMAIL    = 'info@hetekraan.nl';

const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-04-15',
  'Content-Type': 'application/json',
};

async function getOrCreateNotifyContact() {
  // Zoek contact op email
  const search = await fetch(
    `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(NOTIFY_EMAIL)}&limit=1`,
    { headers: GHL_HEADERS }
  );
  const data = await search.json();
  const existing = data?.contacts?.[0];
  if (existing?.id) return existing.id;

  // Aanmaken als niet bestaat
  const create = await fetch(`${GHL_BASE}/contacts/`, {
    method: 'POST',
    headers: GHL_HEADERS,
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      email: NOTIFY_EMAIL,
      firstName: 'Hetekraan',
      lastName: 'Monitoring',
    }),
  });
  const created = await create.json();
  return created?.contact?.id || null;
}

export async function sendErrorNotification(subject, details) {
  try {
    const contactId = await getOrCreateNotifyContact();
    if (!contactId) {
      console.warn('[notify] Geen contactId gevonden voor', NOTIFY_EMAIL);
      return;
    }

    const html = `
      <div style="font-family: sans-serif; max-width: 600px;">
        <h2 style="color: #e53e3e;">⚠️ Fout in Hetekraan Planning</h2>
        <p><strong>Tijd:</strong> ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</p>
        <p><strong>Omschrijving:</strong> ${subject}</p>
        <hr style="border-color: #eee;">
        <pre style="background: #f5f5f5; padding: 12px; border-radius: 6px; font-size: 13px; white-space: pre-wrap;">${details}</pre>
        <p style="color: #999; font-size: 12px;">
          Gegenereerd door Hetekraan Planning op Vercel.
        </p>
      </div>
    `.trim();

    const res = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        type: 'Email',
        contactId,
        html,
        subject: `[Hetekraan] ${subject}`,
        emailTo: NOTIFY_EMAIL,
        emailFrom: `monitoring@hetekraan.nl`,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[notify] GHL email mislukt:', res.status, err);
    } else {
      console.log('[notify] foutmelding verstuurd via GHL naar', NOTIFY_EMAIL);
    }
  } catch (err) {
    console.error('[notify] fout bij versturen notificatie:', err.message);
  }
}
