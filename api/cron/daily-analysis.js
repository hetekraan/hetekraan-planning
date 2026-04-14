// api/cron/daily-analysis.js
// Runs daily at 06:00 UTC via Vercel Cron.
// For each conversation with activity in the last 24 hours:
//   1. Fetches the full message history
//   2. Sends it to OpenRouter (GPT-4o-mini) to extract all relevant fields
//   3. Saves extracted fields back to the contact in GHL

import { fetchWithRetry } from '../../lib/retry.js';
import { sendErrorNotification } from '../../lib/notify.js';
import { logCanonicalAddressWrite } from '../../lib/ghl-contact-canonical.js';
import {
  appendBookingCanonFields,
  formatPriceRulesStructuredString,
  toPriceNumber,
} from '../../lib/booking-canon-fields.js';

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE        = 'https://services.leadconnectorhq.com';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE    = 'https://openrouter.ai/api/v1';

// GHL custom field IDs
const FIELDS = {
  probleemomschrijving: 'BBcbPCNA9Eu0Kyi4U1LN',
  woonplaats:           'mFRQjlUppycMfyjENKF9',
  straatnaam:           'ZwIMY4VPelG5rKROb5NR',
  huisnummer:           'co5Mr16rF6S6ay5hJOSJ',
  postcode:             '3bCi5hL0rR9XGG33x2Gv',
  type_onderhoud:       'EXSQmlt7BqkXJMs8F3Qk',
  afgesproken_prijs:    'HGjlT6ofaBiMz3j2HsXL',
  prijs_regels:         'gPjrUG2eH81PeALh8tVS',
  tijdafspraak:         'RfKARymCOYYkufGY053T',
};

const GHL_HEADERS = () => ({
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-04-15',
  'Content-Type': 'application/json',
});

async function getConversationPage(page, pageSize) {
  const url = `${GHL_BASE}/conversations/search?locationId=${GHL_LOCATION_ID}&limit=${pageSize}&page=${page}`;
  const res = await fetch(url, { headers: GHL_HEADERS() });
  const data = await res.json();
  return {
    conversations: data?.conversations || [],
    total: data?.total || 0,
  };
}

async function getMessages(conversationId) {
  const url = `${GHL_BASE}/conversations/${conversationId}/messages?limit=30`;
  const res = await fetch(url, { headers: GHL_HEADERS() });
  const data = await res.json();
  return data?.messages?.messages || [];
}

async function analyseGesprek(messages, contactName) {
  // Bouw transcript op van oud naar nieuw
  const transcript = [...messages]
    .reverse()
    .filter(m => m.body?.trim())
    .map(m => {
      const wie = m.direction === 'inbound' ? (contactName || 'Klant') : 'Monteur';
      return `${wie}: ${m.body.trim()}`;
    })
    .join('\n');

  if (!transcript) return null;

  const prompt = `Je bent een slimme assistent voor "Het Ekraan", een bedrijf dat Quooker-kranen verkoopt, installeert en onderhoudt.

Analyseer onderstaand WhatsApp-gesprek en extraheer de volgende gegevens. Geef je antwoord ALLEEN als geldig JSON, zonder uitleg, zonder markdown.

Te extraheren velden:
- "probleemomschrijving": korte, actie-gerichte omschrijving van wat er gedaan moet worden (niet het probleem, maar de werkzaamheid). Max 1 zin, zonder hoofdletter, zonder punt. Voorbeelden: "standaard onderhoudsbeurt", "nieuwe RVS round flex plaatsen", "cartridge vervangen", "quooker installeren". Als onduidelijk: "werkzaamheden onbekend"
- "type_onderhoud": een van deze drie exacte waarden:
  * "reparatie" → als er iets kapot is, lekt, niet werkt, storing heeft, of gerepareerd moet worden
  * "onderhoud" → alleen als de klant expliciet vraagt om periodiek/jaarlijks onderhoud zonder dat er iets kapot is
  * "nieuwe quooker" → als de klant een nieuwe Quooker wil kopen of laten installeren
  * null → als het echt onduidelijk is
- "woonplaats": de stad/woonplaats van de klant, of null als niet vermeld.
- "straatnaam": de straatnaam, of null als niet vermeld.
- "huisnummer": het huisnummer, of null als niet vermeld.
- "postcode": de postcode, of null als niet vermeld.
- "leeftijd_quooker": leeftijd of bouwjaar van de Quooker als tekst (bv. "3 jaar" of "2021"), of null.
- "leeftijd_kraan": leeftijd of bouwjaar van de kraan als tekst, of null.
- "tijdafspraak": het afgesproken tijdstip of tijdsvenster waarop de klant verwacht dat we komen, als dat uit het gesprek blijkt. Gebruik altijd de notatie "HH:MM-HH:MM" (bijv. "09:00-11:00") of "rond HH:MM" (bijv. "rond 10:00"). Als alleen ochtend of middag is afgesproken, gebruik dan "ochtend" of "middag". Geef null als er geen specifieke tijd is afgesproken.
- "afgesproken_prijs": het totaalbedrag in euros (alleen het getal, bijv. "245") als:
  * Het Ekraan een prijs noemt EN de klant reageert met iets als "akkoord", "goed", "prima", "ok", "ja", "oké", "dat is goed" of een vergelijkbare bevestiging.
  * Geef null als er geen prijs is, of als de klant nog geen akkoord heeft gegeven.
  * Geef ALLEEN het getal terug, zonder €-teken of tekst. Bijv: "195" of "245"
- "prijs_regels": een JSON-array met de opbouw van de afgesproken prijs, als die opbouw uit het gesprek op te maken is. Elk item heeft "desc" (omschrijving) en "price" (getal zonder €).
  * Voorbeeld: [{"desc":"Onderhoud","price":195},{"desc":"Voorrijkosten","price":50}]
  * Geef null als er geen duidelijke opbouw is of als er geen prijs is afgesproken.
  * Gebruik duidelijke, korte Nederlandse omschrijvingen.

Gesprek:
${transcript.slice(0, 3000)}

Geef ALLEEN dit JSON-object terug:
{
  "probleemomschrijving": "...",
  "type_onderhoud": "...",
  "woonplaats": "...",
  "straatnaam": "...",
  "huisnummer": "...",
  "postcode": "...",
  "leeftijd_quooker": "...",
  "leeftijd_kraan": "...",
  "tijdafspraak": "...",
  "afgesproken_prijs": "...",
  "prijs_regels": null
}`;

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://hetekraan-planning.vercel.app',
      'X-Title': 'Hetekraan Planning',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
  });

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToContact(contactId, extracted) {
  const customFields = [];

  for (const [key, fieldId] of Object.entries(FIELDS)) {
    let value = extracted[key];
    if (!value || value === 'null') continue;
    // prijs_regels is een array → opslaan als JSON-string
    if (key === 'prijs_regels') {
      if (Array.isArray(value) && value.length > 0) {
        const js = JSON.stringify(value);
        customFields.push({ id: fieldId, value: js, field_value: js });
      }
      continue;
    }
    if (key === 'probleemomschrijving' || value) {
      const s = String(value);
      customFields.push({ id: fieldId, value: s, field_value: s });
    }
  }

  const addrLine = [
    extracted.straatnaam,
    extracted.huisnummer,
    extracted.postcode,
    extracted.woonplaats,
  ]
    .filter((v) => v && v !== 'null')
    .map((v) => String(v).trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const payload = {};
  if (addrLine) payload.address1 = addrLine;
  if (extracted.postcode && extracted.postcode !== 'null') {
    payload.postalCode = String(extracted.postcode).replace(/\s+/g, ' ').trim();
  }
  if (extracted.woonplaats && extracted.woonplaats !== 'null') {
    payload.city = String(extracted.woonplaats).trim();
  }
  if (customFields.length) payload.customFields = customFields;

  const canonValues = {
    straat_huisnummer: [extracted.straatnaam, extracted.huisnummer]
      .filter((v) => v && v !== 'null')
      .map((v) => String(v).trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
    postcode: extracted.postcode,
    woonplaats: extracted.woonplaats,
    tijdslot: extracted.tijdafspraak,
    type_onderhoud: extracted.type_onderhoud,
    probleemomschrijving: extracted.probleemomschrijving,
    prijs_regels: formatPriceRulesStructuredString(extracted.prijs_regels),
    prijs_totaal: toPriceNumber(extracted.afgesproken_prijs),
    betaal_status: extracted.betaal_status,
  };
  const bookingCanon = appendBookingCanonFields(payload.customFields || [], canonValues);
  payload.customFields = bookingCanon.customFields;
  console.log('[BOOKING_CANON_WRITE]', bookingCanon.written);

  if (!payload.address1 && !payload.customFields?.length) return;

  logCanonicalAddressWrite('daily-analysis_whatsapp_extract', {
    contactId,
    address1: payload.address1 || null,
    customFieldCount: customFields.length,
  });

  // Fase 1: automatische WhatsApp -> GHL veldwrites uitgeschakeld.
  // We behouden extractie + payload-opbouw voor interne analyse/diagnostiek.
  console.info('[daily-analysis] write disabled (dry-run)', {
    contactId,
    address1: payload.address1 || null,
    customFieldCount: Array.isArray(payload.customFields) ? payload.customFields.length : 0,
  });
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!GHL_API_KEY || !GHL_LOCATION_ID || !OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Missing env vars: GHL_API_KEY, GHL_LOCATION_ID, OPENROUTER_API_KEY' });
  }

  console.log('[daily-analysis] start');

  // GHL pagineert met page+limit. We mappen onze offset direct naar een GHL pagina.
  // ?batchSize=50&offset=0  → page 1 van GHL
  // ?batchSize=50&offset=50 → page 2 van GHL
  const batchSize = req.query?.batchSize ? parseInt(req.query.batchSize, 10) : 50;
  const offset    = req.query?.offset    ? parseInt(req.query.offset, 10)    : 0;
  const page      = Math.floor(offset / batchSize) + 1;

  // allTime=true → geen hours filter (voor historische run)
  const allTime   = req.query?.allTime === 'true';
  const hoursBack = req.query?.hours ? parseInt(req.query.hours, 10) : 24;
  const cutoff    = allTime ? 0 : Date.now() - hoursBack * 60 * 60 * 1000;

  const { conversations: pageFetched, total: ghlTotal } = await getConversationPage(page, batchSize);

  // Filter op activiteit (sla over als allTime=true)
  const batch = allTime
    ? pageFetched
    : pageFetched.filter(c => c.lastMessageDate && c.lastMessageDate > cutoff);

  console.log(`[daily-analysis] page=${page} batchSize=${batchSize} offset=${offset} ghlTotal=${ghlTotal} batch=${batch.length}`);

  const results = [];
  let success = 0;
  let skipped = 0;
  let failed = 0;

  // Verwerk 5 gesprekken tegelijk (parallel)
  const CONCURRENCY = 5;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (conv) => {
      const contactId = conv.contactId;
      if (!contactId) { skipped++; return; }

      try {
        const messages = await getMessages(conv.id);
        if (!messages.length) { skipped++; return; }

        const extracted = await analyseGesprek(messages, conv.contactName || conv.fullName);
        if (!extracted) { skipped++; return; }

        await saveToContact(contactId, extracted);
        success++;
        results.push({ contactId, name: conv.fullName, ...extracted });
        console.log(`[daily-analysis] ✓ ${conv.fullName}: ${extracted.probleemomschrijving}`);
      } catch (err) {
        failed++;
        console.error(`[daily-analysis] ✗ ${conv.fullName || contactId}:`, err.message);
      }
    }));
  }

  const nextOffset = offset + batchSize < ghlTotal ? offset + batchSize : null;
  console.log(`[daily-analysis] klaar. success=${success} skipped=${skipped} failed=${failed} nextOffset=${nextOffset}`);

  // Stuur email als er fouten zijn
  if (failed > 0) {
    const failedNames = results
      .filter(r => r.error)
      .map(r => r.name || r.contactId)
      .join(', ');
    await sendErrorNotification(
      `Dagelijkse analyse: ${failed} fouten`,
      `Verwerkt: ${batch.length} | Succesvol: ${success} | Overgeslagen: ${skipped} | Fouten: ${failed}\n\nMislukte contacten: ${failedNames || 'onbekend'}\n\nOffset: ${offset}, Batch: ${batch.length}`
    );
  }

  return res.status(200).json({
    ok: true,
    ghlTotal,
    processed: batch.length,
    offset,
    nextOffset,
    success,
    skipped,
    failed,
    results,
  });
}
