/**
 * Eenmalig 7 testcontacten + kalenderafspraken in GHL (ma 13 apr 2026).
 * Beveiligd: zet ALLOW_GHL_TEST_SEED=true en SEED_TEST_SECRET in Vercel.
 *
 * curl -X POST https://JOUW-SITE/api/seed-test-appointments \
 *   -H "Authorization: Bearer JOUW_SECRET" \
 *   -H "Content-Type: application/json"
 */

import { amsterdamWallTimeToDate } from '../lib/amsterdam-wall-time.js';
import { ghlDurationMinutesForType, normalizeWorkType } from '../lib/booking-blocks.js';
import { fetchWithRetry } from '../lib/retry.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

/** Zelfde IDs als api/ghl.js — bij wijziging daar sync houden */
const FIELD_IDS = {
  straatnaam: 'ZwIMY4VPelG5rKROb5NR',
  huisnummer: 'co5Mr16rF6S6ay5hJOSJ',
  postcode: '3bCi5hL0rR9XGG33x2Gv',
  woonplaats: 'mFRQjlUppycMfyjENKF9',
  type_onderhoud: 'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving: 'BBcbPCNA9Eu0Kyi4U1LN',
  tijdafspraak: 'RfKARymCOYYkufGY053T',
  opmerkingen: 'LCIFALarX3WZI5jsBbDA',
};

const TEST_TAG = 'hk-test-seed';
const ROUTE_DATE = '2026-04-13';

/** 7 rijen: mix types, Amsterdam-adressen; telefoon in loop: +31612345671 … +31612345677 */
const SEED_ROWS = [
  { firstName: 'Sophie', lastName: 'Visser', straatnaam: 'Rijnstraat', huisnummer: '45', postcode: '1078 PV', woonplaats: 'Amsterdam', type: 'onderhoud', desc: 'Jaarlijks onderhoud ketel en rookgasafvoer', tijdafspraak: 'Ochtend tussen 09 en 13 uur', hour: 9, minute: 15 },
  { firstName: 'Lucas', lastName: 'Bakker', straatnaam: 'Van Woustraat', huisnummer: '112', postcode: '1073 LC', woonplaats: 'Amsterdam', type: 'reparatie', desc: 'Lekkage mengkraan badkamer', tijdafspraak: '', hour: 9, minute: 45 },
  { firstName: 'Emma', lastName: 'Mulder', straatnaam: 'Ceintuurbaan', huisnummer: '200', postcode: '1074 CX', woonplaats: 'Amsterdam', type: 'installatie', desc: 'Nieuwe douchethermostaat installeren', tijdafspraak: 'Rond 10:30', hour: 10, minute: 30 },
  { firstName: 'Noah', lastName: 'Smit', straatnaam: 'Ferdinand Bolstraat', huisnummer: '88', postcode: '1072 LM', woonplaats: 'Amsterdam', type: 'onderhoud', desc: 'Cv-onderhoud en ontluchten', tijdafspraak: '', hour: 11, minute: 30 },
  { firstName: 'Julia', lastName: 'De Jong', straatnaam: 'Albert Cuypstraat', huisnummer: '55', postcode: '1072 CM', woonplaats: 'Amsterdam', type: 'reparatie', desc: 'Storing warmwaterbereiding', tijdafspraak: 'Middag tussen 13 en 17 uur', hour: 13, minute: 0 },
  { firstName: 'Finn', lastName: 'Van Dam', straatnaam: 'Eerste van der Helststraat', huisnummer: '42', postcode: '1072 NZ', woonplaats: 'Amsterdam', type: 'installatie', desc: 'Cartridge FLEX vervangen', tijdafspraak: '', hour: 14, minute: 15 },
  { firstName: 'Lisa', lastName: 'Meijer', straatnaam: 'Marie Heinekenplein', huisnummer: '12', postcode: '1072 MH', woonplaats: 'Amsterdam', type: 'onderhoud', desc: 'Legionella-spoeling + controle', tijdafspraak: 'Middag', hour: 15, minute: 30 },
];

function checkAuth(req) {
  if (process.env.ALLOW_GHL_TEST_SEED !== 'true') {
    return { ok: false, status: 403, error: 'Niet actief. Zet ALLOW_GHL_TEST_SEED=true in Vercel (en daarna weer uit na gebruik).' };
  }
  const expected = process.env.SEED_TEST_SECRET;
  if (!expected || String(expected).length < 12) {
    return { ok: false, status: 503, error: 'SEED_TEST_SECRET ontbreekt of is te kort (min. 12 tekens).' };
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const bodySecret = req.body && typeof req.body.secret === 'string' ? req.body.secret.trim() : '';
  if (bearer === expected || bodySecret === expected) return { ok: true };
  return { ok: false, status: 401, error: 'Ongeldige secret. Gebruik header Authorization: Bearer … of JSON { "secret": "…" }' };
}

async function postJson(url, body, apiKey, version = '2021-07-28') {
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: version,
      },
      body: JSON.stringify(body),
    },
    1
  );
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { res, data };
}

async function putJson(url, body, apiKey) {
  const res = await fetchWithRetry(
    url,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15',
      },
      body: JSON.stringify(body),
    },
    1
  );
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { res, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Gebruik POST naar /api/seed-test-appointments' });
  }

  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const calendarId = process.env.GHL_CALENDAR_ID;
  if (!apiKey || !locationId || !calendarId) {
    return res.status(503).json({ error: 'GHL_API_KEY, GHL_LOCATION_ID of GHL_CALENDAR_ID ontbreekt' });
  }

  const dryRun = req.body?.dryRun === true;
  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      date: ROUTE_DATE,
      count: SEED_ROWS.length,
      rows: SEED_ROWS.map((r, i) => ({
        name: `${r.firstName} ${r.lastName}`,
        phone: `+3161234567${i + 1}`,
        time: `${r.hour}:${String(r.minute).padStart(2, '0')}`,
        type: r.type,
      })),
    });
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < SEED_ROWS.length; i++) {
    const row = SEED_ROWS[i];
    const phone = `+3161234567${i + 1}`;
    const typeNorm = normalizeWorkType(row.type);
    const durationMin = ghlDurationMinutesForType(typeNorm);
    const title = `${row.firstName} ${row.lastName} – ${typeNorm}`;

    try {
      const { res: cRes, data: cData } = await postJson(
        `${GHL_BASE}/contacts/`,
        {
          locationId,
          firstName: row.firstName,
          lastName: row.lastName,
          phone,
          source: 'HK test seed',
        },
        apiKey
      );

      if (!cRes.ok) {
        errors.push({ step: 'contact', row: i + 1, name: title, status: cRes.status, detail: cData });
        continue;
      }

      const contactId = cData?.contact?.id || cData?.id;
      if (!contactId) {
        errors.push({ step: 'contact', row: i + 1, name: title, detail: 'Geen contact id in response', cData });
        continue;
      }

      const customFields = [
        { id: FIELD_IDS.straatnaam, field_value: row.straatnaam },
        { id: FIELD_IDS.huisnummer, field_value: row.huisnummer },
        { id: FIELD_IDS.postcode, field_value: row.postcode },
        { id: FIELD_IDS.woonplaats, field_value: row.woonplaats },
        { id: FIELD_IDS.type_onderhoud, field_value: typeNorm },
        { id: FIELD_IDS.probleemomschrijving, field_value: row.desc },
        { id: FIELD_IDS.opmerkingen, field_value: `HK test-seed ${ROUTE_DATE} — tag ${TEST_TAG}, na test verwijderen` },
      ];
      if (row.tijdafspraak) {
        customFields.push({ id: FIELD_IDS.tijdafspraak, field_value: row.tijdafspraak });
      }

      const { res: uRes, data: uData } = await putJson(`${GHL_BASE}/contacts/${contactId}`, { customFields }, apiKey);
      if (!uRes.ok) {
        errors.push({ step: 'customFields', row: i + 1, contactId, status: uRes.status, detail: uData });
      }

      const startD = amsterdamWallTimeToDate(ROUTE_DATE, row.hour, row.minute);
      if (!startD) {
        errors.push({ step: 'time', row: i + 1, contactId, detail: 'Kon starttijd niet berekenen' });
        continue;
      }
      const startIso = startD.toISOString();
      const endIso = new Date(startD.getTime() + durationMin * 60 * 1000).toISOString();

      const { res: aRes, data: aData } = await postJson(
        `${GHL_BASE}/calendars/events/appointments`,
        {
          calendarId,
          locationId,
          contactId,
          startTime: startIso,
          endTime: endIso,
          title,
          appointmentStatus: 'confirmed',
          ignoreLimits: true,
        },
        apiKey
      );

      if (!aRes.ok) {
        errors.push({ step: 'appointment', row: i + 1, contactId, status: aRes.status, detail: aData });
        created.push({ contactId, appointmentId: null, name: title, warning: 'Kalender mislukt' });
        continue;
      }

      const appointmentId = aData?.id || aData?.event?.id || null;

      await postJson(`${GHL_BASE}/contacts/${contactId}/tags`, { tags: [TEST_TAG] }, apiKey, '2021-04-15');

      created.push({ contactId, appointmentId, name: title, phone, start: startIso });
    } catch (e) {
      errors.push({ step: 'exception', row: i + 1, detail: e.message });
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return res.status(errors.length && !created.length ? 502 : 200).json({
    success: errors.length === 0,
    date: ROUTE_DATE,
    tag: TEST_TAG,
    created,
    errors,
    hint: 'Verwijder testdata in GHL via filter op tag hk-test-seed of telefoon +31612345671 t/m +31612345677',
  });
}
