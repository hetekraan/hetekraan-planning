// api/ghl.js — met custom field IDs
import { fetchWithRetry } from '../lib/retry.js';
import { sendErrorNotification } from '../lib/notify.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Custom field ID mapping
const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  postcode:            '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:          'mFRQjlUppycMfyjENKF9',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  prijs:               'HGjlT6ofaBiMz3j2HsXL',
  prijs_regels:        'gPjrUG2eH81PeALh8tVS',
  tijdafspraak:        'RfKARymCOYYkufGY053T',
  opmerkingen:         'LCIFALarX3WZI5jsBbDA',
};

function getField(contact, fieldId) {
  if (!contact?.customFields) return '';
  const field = contact.customFields.find(f => f.id === fieldId);
  return field?.value || '';
}

/**
 * GHL: start/einde van een kalender-item zetten.
 * Sommige omgevingen gebruiken PUT …/appointments/:id, andere …/events/:id — we proberen beide + API-versies.
 */
async function putCalendarStartEnd(eventId, startIso, endIso) {
  if (!eventId) return { ok: false, err: 'Geen kalender-id' };

  const body = JSON.stringify({
    calendarId: GHL_CALENDAR_ID,
    locationId: GHL_LOCATION_ID,
    startTime: startIso,
    endTime: endIso,
    ignoreLimits: true,
    ignoreDateRange: true,
  });

  const paths = [
    `${GHL_BASE}/calendars/events/appointments/${eventId}`,
    `${GHL_BASE}/calendars/events/${eventId}`,
  ];
  const versions = ['2021-04-15', '2021-07-28'];
  let lastErr = '';

  for (const url of paths) {
    for (const Version of versions) {
      const res = await fetchWithRetry(
        url,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version,
          },
          body,
        },
        0
      );
      if (res.ok) {
        return { ok: true, url: url.split('/').slice(-3).join('/') };
      }
      const t = await res.text();
      lastErr = `${res.status} ${t}`.slice(0, 400);
    }
  }
  return { ok: false, err: lastErr || 'Kalender PUT mislukt' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    switch (action) {

      case 'getAppointments': {
        const { date } = req.query;
        const startMs = new Date(`${date}T00:00:00+01:00`).getTime();
        const endMs   = new Date(`${date}T23:59:59+01:00`).getTime();
        const url = `${GHL_BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${GHL_CALENDAR_ID}&startTime=${startMs}&endTime=${endMs}`;
        const response = await fetchWithRetry(url, {
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
        });
        const data = await response.json();
        const events = data?.events || [];

        const enriched = await Promise.all(events.map(async (e) => {
          if (!e.contactId) return e;
          try {
            const cr = await fetchWithRetry(`${GHL_BASE}/contacts/${e.contactId}`, {
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
            });
            const cd = await cr.json();
            const contact = cd?.contact || cd;
            e.contact = contact;

            // Adres opbouwen uit custom fields
            const straat     = getField(contact, FIELD_IDS.straatnaam);
            const huisnr     = getField(contact, FIELD_IDS.huisnummer);
            const postcode   = getField(contact, FIELD_IDS.postcode);
            const woonplaats = getField(contact, FIELD_IDS.woonplaats) || contact.city || '';
            e.parsedAddress  = [straat, huisnr, postcode, woonplaats].filter(Boolean).join(' ');
            e.parsedStraatnaam = straat;
            e.parsedHuisnummer = huisnr;
            e.parsedPostcode   = postcode;
            e.parsedWoonplaats = woonplaats;

            // Werkzaamheden
            const werkzaamheden = getField(contact, FIELD_IDS.probleemomschrijving);
            e.parsedWork = werkzaamheden || e.title;

            // Prijs en opmerkingen
            e.parsedPrice = getField(contact, FIELD_IDS.prijs);
            e.parsedNotes = getField(contact, FIELD_IDS.opmerkingen);

            // Tijdafspraak uit AI-analyse
            e.parsedTimeWindow = getField(contact, FIELD_IDS.tijdafspraak) || null;

            // Prijsopbouw uit AI-analyse
            const prijsRegelsRaw = getField(contact, FIELD_IDS.prijs_regels);
            if (prijsRegelsRaw) {
              try { e.parsedExtras = JSON.parse(prijsRegelsRaw); } catch (_) {}
            }

          } catch(_) {}
          return e;
        }));

        return res.status(200).json({ events: enriched });
      }

      case 'updateContactDashboard': {
        const editedBy = String(req.body?.editedBy || '').toLowerCase().trim();
        if (editedBy !== 'daan') {
          return res.status(403).json({ error: 'Alleen ingelogde gebruiker Daan kan dit endpoint gebruiken' });
        }

        const {
          contactId,
          firstName,
          lastName,
          phone,
          straatnaam,
          huisnummer,
          postcode,
          woonplaats,
          typeOnderhoud,
          probleemomschrijving,
          tijdafspraak,
          opmerkingen,
          prijs,
          appointmentTime,
          routeDate,
          ghlAppointmentId,
          durationMin,
        } = req.body;

        if (!contactId) {
          return res.status(400).json({ error: 'contactId vereist' });
        }

        const customFields = [];
        const pushField = (id, val) => {
          if (val === undefined || val === null) return;
          const s = String(val).trim();
          customFields.push({ id, field_value: s });
        };

        pushField(FIELD_IDS.straatnaam, straatnaam);
        pushField(FIELD_IDS.huisnummer, huisnummer);
        pushField(FIELD_IDS.postcode, postcode);
        pushField(FIELD_IDS.woonplaats, woonplaats);
        pushField(FIELD_IDS.type_onderhoud, typeOnderhoud);
        pushField(FIELD_IDS.probleemomschrijving, probleemomschrijving);
        pushField(FIELD_IDS.tijdafspraak, tijdafspraak);
        pushField(FIELD_IDS.opmerkingen, opmerkingen);
        pushField(FIELD_IDS.prijs, prijs);

        const payload = {};
        if (firstName !== undefined) payload.firstName = String(firstName).trim();
        if (lastName !== undefined) payload.lastName = String(lastName).trim();
        if (phone !== undefined) payload.phone = String(phone).replace(/\s/g, '');
        if (customFields.length) payload.customFields = customFields;

        if (Object.keys(payload).length === 0) {
          return res.status(400).json({ error: 'Geen velden om bij te werken' });
        }

        const putRes = await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            Version: '2021-04-15',
          },
          body: JSON.stringify(payload),
        });

        if (!putRes.ok) {
          const t = await putRes.text();
          console.error('[updateContactDashboard] GHL PUT contact:', t);
          return res.status(502).json({ error: 'GHL contact bijwerken mislukt', detail: t.slice(0, 400) });
        }

        let calendarSynced = false;
        let calendarError;
        if (ghlAppointmentId && routeDate && appointmentTime) {
          const dur = Math.max(5, Math.min(480, Number(durationMin) || 30));
          const tm = String(appointmentTime).trim().replace(/^~/, '');
          const parts = tm.split(':');
          const hh = String(Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0))).padStart(2, '0');
          const mm = String(Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0))).padStart(2, '0');
          const startMs = new Date(`${routeDate}T${hh}:${mm}:00+01:00`).getTime();
          if (!Number.isNaN(startMs)) {
            const startIso = new Date(startMs).toISOString();
            const endIso   = new Date(startMs + dur * 60 * 1000).toISOString();
            const cal = await putCalendarStartEnd(ghlAppointmentId, startIso, endIso);
            calendarSynced = cal.ok;
            if (!cal.ok) calendarError = cal.err;
          }
        }

        return res.status(200).json({
          success: true,
          calendarSynced,
          calendarError: calendarError || undefined,
        });
      }

      case 'completeAppointment': {
        const { contactId, appointmentId, type, sendReview, lastService, totalPrice, extras } = req.body;
        const today = new Date().toISOString().split('T')[0];
        const customFields = [
          { id: 'hiTe3Yi5TlxheJq4bLzy', field_value: today } // datum_laatste_onderhoud
        ];
        if (type === 'installatie') {
          customFields.push({ id: 'kYP2SCmhZ21Ig0aaLl5l', field_value: today }); // datum_installatie
        }
        if (totalPrice != null) {
          customFields.push({ id: FIELD_IDS.prijs, field_value: String(totalPrice) });
        }
        if (Array.isArray(extras) && extras.length > 0) {
          customFields.push({ id: FIELD_IDS.prijs_regels, field_value: JSON.stringify(extras) });
        }
        await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
          body: JSON.stringify({ customFields })
        });
        await addTag(contactId, 'factuur-versturen');
        if (sendReview) await addTag(contactId, 'review-mail-versturen');
        if (appointmentId) await updateOpportunityStage(contactId, 'Uitgevoerd');
        return res.status(200).json({ success: true });
      }

      case 'saveRouteTimes': {
        // Custom field geplande aankomst + optioneel GHL-kalender bijwerken
        const { routeTimes } = req.body; // [{ contactId, plannedTime, ghlAppointmentId?, routeDate?, startTime?, durationMin? }]
        if (!Array.isArray(routeTimes) || routeTimes.length === 0) {
          return res.status(400).json({ error: 'routeTimes array vereist' });
        }
        const results = [];
        const calendarErrors = [];
        let calendarSynced = 0;
        for (const row of routeTimes) {
          const { contactId, plannedTime, ghlAppointmentId, routeDate, startTime, durationMin } = row;
          if (!contactId || !plannedTime) continue;

          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              customFields: [{ id: 'XELcOSdWq3tqRtpLE5x8', field_value: plannedTime }]
            })
          });
          results.push({ contactId, plannedTime });

          if (ghlAppointmentId && routeDate && startTime) {
            const dur = Math.max(5, Math.min(480, Number(durationMin) || 30));
            const tm = String(startTime).trim().replace(/^~/, '');
            const parts = tm.split(':');
            const hh = String(Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0))).padStart(2, '0');
            const mm = String(Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0))).padStart(2, '0');
            const startMs = new Date(`${routeDate}T${hh}:${mm}:00+01:00`).getTime();
            if (Number.isNaN(startMs)) {
              calendarErrors.push({ ghlAppointmentId, err: 'Ongeldige datum/tijd' });
              continue;
            }
            const startIso = new Date(startMs).toISOString();
            const endIso   = new Date(startMs + dur * 60 * 1000).toISOString();

            const putResult = await putCalendarStartEnd(ghlAppointmentId, startIso, endIso);
            if (putResult.ok) {
              calendarSynced++;
              console.log(`[saveRouteTimes] Kalender OK ${ghlAppointmentId} via ${putResult.url}`);
            } else {
              console.warn(`[saveRouteTimes] Kalender update mislukt ${ghlAppointmentId}:`, putResult.err);
              calendarErrors.push({ ghlAppointmentId, err: putResult.err?.slice(0, 220) || 'onbekend' });
            }
          }
        }
        console.log(`[saveRouteTimes] ${results.length} contacten bijgewerkt, kalender OK: ${calendarSynced}, fouten: ${calendarErrors.length}`);
        return res.status(200).json({
          success: true,
          saved: results.length,
          calendarSynced,
          calendarErrors: calendarErrors.length ? calendarErrors : undefined,
        });
      }

      case 'createAppointment': {
        const { name, phone, address, date, time, type: apptType, desc, contactId: existingContactId } = req.body;

        // Stap 1: contact opzoeken of aanmaken
        let contactId = existingContactId;
        if (!contactId) {
          // Zoek bestaand contact op telefoonnummer
          // Zoek op nummer (GHL duplicate check)
          const searchPhone = phone ? phone.replace(/\s/g, '') : '';
          if (searchPhone) {
            const searchRes = await fetchWithRetry(
              `${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(searchPhone)}`,
              { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              contactId = searchData?.contact?.id || null;
            }
          }
          // Zoek op naam als telefoonnummer niet gevonden
          if (!contactId && name) {
            const nameSearch = await fetchWithRetry(
              `${GHL_BASE}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(name)}&limit=1`,
              { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28' } }
            );
            if (nameSearch.ok) {
              const nameData = await nameSearch.json();
              contactId = nameData?.contacts?.[0]?.id || null;
            }
          }
          // Nieuw contact aanmaken als niet gevonden
          if (!contactId) {
            const nameParts = name.trim().split(' ');
            const createRes = await fetchWithRetry(`${GHL_BASE}/contacts/`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
              body: JSON.stringify({
                locationId: GHL_LOCATION_ID,
                firstName: nameParts[0] || name,
                lastName: nameParts.slice(1).join(' ') || '',
                phone: searchPhone || '',
                address1: address || '',
              })
            });
            if (createRes.ok) {
              const createData = await createRes.json();
              contactId = createData?.contact?.id || null;
            }
          }
        }

        if (!contactId) return res.status(400).json({ error: 'Kon geen contact vinden of aanmaken' });

        // Stap 2: adres opslaan als custom field
        if (address) {
          const parts = address.split(' ');
          const huisnummer = parts.find(p => /^\d/.test(p)) || '';
          const straatnaam = parts.slice(0, parts.indexOf(huisnummer)).join(' ') || address;
          await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              customFields: [
                { id: FIELD_IDS.straatnaam, field_value: straatnaam },
                { id: FIELD_IDS.huisnummer, field_value: huisnummer },
                { id: FIELD_IDS.type_onderhoud, field_value: apptType || 'reparatie' },
                { id: FIELD_IDS.probleemomschrijving, field_value: desc || '' },
              ]
            })
          });
        }

        // Stap 3: agenda-afspraak aanmaken (met retry bij slot-conflict)
        const [hours, minutes] = (time || '09:00').split(':').map(Number);
        const durationMap = { installatie: 60, onderhoud: 30, reparatie: 45 };
        const durationMin = durationMap[apptType] || 30;

        let appointmentId = null;
        let lastError = null;
        // Probeer de gevraagde tijd, dan stapsgewijs eerder (zodat de afspraak op de juiste dag blijft)
        const offsets = [0, -5, 5, -10, 10, -15, 15, -30, 30];
        for (const offsetMin of offsets) {
          const startMs = new Date(`${date}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00+01:00`).getTime()
            + offsetMin * 60 * 1000;
          const startTime = new Date(startMs);
          const endTime   = new Date(startMs + durationMin * 60 * 1000);

          const apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
            body: JSON.stringify({
              calendarId: GHL_CALENDAR_ID,
              locationId: GHL_LOCATION_ID,
              contactId,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              title: `${name} – ${apptType || 'afspraak'}`,
              appointmentStatus: 'confirmed',
              ignoreLimits: true,
            })
          });

          if (apptRes.ok) {
            const apptData = await apptRes.json();
            appointmentId = apptData?.id;
            break;
          }
          const errText = await apptRes.text();
          lastError = errText;
          if (!errText.includes('slot') && !errText.includes('available')) break; // ander fout → niet retrien
        }

        if (!appointmentId) {
          console.error('[createAppointment] Alle tijdslots geprobeerd, mislukt:', lastError);
          // Contact is wel aangemaakt/gevonden — geef dat terug zodat de afspraak zichtbaar blijft
          return res.status(200).json({ success: true, contactId, appointmentId: null, warning: 'Kalender-slot niet beschikbaar, alleen contact opgeslagen' });
        }

        return res.status(200).json({ success: true, contactId, appointmentId });
      }

      case 'sendETA': {
        // TESTMODUS: WhatsApp tijdelijk uitgeschakeld
        const { contactId, eta, name } = req.body;
        console.log(`[sendETA] TESTMODUS – WhatsApp NIET verstuurd aan contactId=${contactId}, eta=${eta}`);
        return res.status(200).json({ success: true, testMode: true });
      }

      case 'sendMorningMessages': {
        const { appointments } = req.body;
        for (const appt of appointments) {
          await fetchWithRetry(`${GHL_BASE}/conversations/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
            body: JSON.stringify({
              type: 'WhatsApp',
              contactId: appt.contactId,
              message: `Goedemorgen! U staat vandaag in onze planning. Onze monteur is er rond ${appt.timeFrom}. Kunt u voordat de monteur er is alvast het keukenkastje leeg maken zodat hij er makkelijk bij kan? Tot straks!`
            })
          });
        }
        return res.status(200).json({ success: true });
      }

      default:
        return res.status(400).json({ error: 'Onbekende actie' });
    }
  } catch (err) {
    console.error('[ghl] onverwachte fout:', err.message);
    await sendErrorNotification(
      `GHL API fout: ${action}`,
      `Fout: ${err.message}\n\nStack:\n${err.stack}`
    );
    return res.status(500).json({ error: err.message });
  }
}

async function addTag(contactId, tag) {
  await fetchWithRetry(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ tags: [tag] })
  });
}

async function updateOpportunityStage(contactId, stage) {
  const res = await fetchWithRetry(`${GHL_BASE}/opportunities/search?contact_id=${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await res.json();
  const opp = data?.opportunities?.[0];
  if (!opp) return;
  await fetchWithRetry(`${GHL_BASE}/opportunities/${opp.id}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' },
    body: JSON.stringify({ status: stage })
  });
}
