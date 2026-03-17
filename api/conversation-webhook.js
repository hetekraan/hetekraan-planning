// api/conversation-webhook.js
// GHL stuurt een webhook bij elk nieuw bericht → Claude extraheert klantdata → terug naar GHL
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';

// Zelfde veld-IDs als in ghl.js
const FIELD_IDS = {
  straatnaam:           'ZwIMY4VPelG5rKROb5NR',
  huisnummer:           'co5Mr16rF6S6ay5hJOSJ',
  postcode:             '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:           'mFRQjlUppycMfyjENKF9',
  type_onderhoud:       'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving: 'BBcbPCNA9Eu0Kyi4U1LN',
  prijs:                'HGjlT6ofaBiMz3j2HsXL',
  opmerkingen:          'LCIFALarX3WZI5jsBbDA',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;

    // GHL stuurt verschillende webhook-types — we willen alleen inkomende berichten
    const type = payload?.type || payload?.event;
    if (!['InboundMessage', 'ConversationUnreadUpdate'].includes(type)) {
      return res.status(200).json({ skipped: true, type });
    }

    const contactId     = payload.contactId || payload.contact_id;
    const conversationId = payload.conversationId || payload.conversation_id;

    if (!contactId || !conversationId) {
      return res.status(200).json({ skipped: true, reason: 'geen contactId of conversationId' });
    }

    // 1. Haal de laatste berichten op uit GHL
    const messages = await getConversationMessages(conversationId);
    if (!messages.length) return res.status(200).json({ skipped: true, reason: 'geen berichten' });

    // 2. Haal huidige contactdata op (om bestaande velden niet te overschrijven)
    const contact = await getContact(contactId);

    // 3. Stuur berichten naar Claude voor extractie
    const extracted = await extractWithClaude(messages, contact);
    if (!extracted) return res.status(200).json({ skipped: true, reason: 'niets te updaten' });

    // 4. Schrijf geëxtraheerde data terug naar GHL contact
    await updateContact(contactId, extracted);

    return res.status(200).json({ success: true, updated: extracted });

  } catch (err) {
    console.error('conversation-webhook fout:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getConversationMessages(conversationId) {
  const r = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages?limit=30`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await r.json();
  const messages = data?.messages?.messages || data?.messages || [];
  // Alleen tekst-berichten, gesorteerd op tijd
  return messages
    .filter(m => m.body || m.text)
    .sort((a, b) => new Date(a.dateAdded || a.date) - new Date(b.dateAdded || b.date))
    .map(m => ({
      richting: m.direction === 'inbound' ? 'klant' : 'monteur',
      tekst: m.body || m.text || ''
    }));
}

async function getContact(contactId) {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
    });
    const data = await r.json();
    return data?.contact || data || {};
  } catch (_) { return {}; }
}

async function extractWithClaude(messages, contact) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY niet ingesteld');
    return null;
  }

  // Bouw bestaande velden op zodat Claude weet wat al ingevuld is
  const bestaand = {
    straatnaam:           getField(contact, FIELD_IDS.straatnaam),
    huisnummer:           getField(contact, FIELD_IDS.huisnummer),
    postcode:             getField(contact, FIELD_IDS.postcode),
    woonplaats:           getField(contact, FIELD_IDS.woonplaats),
    type_onderhoud:       getField(contact, FIELD_IDS.type_onderhoud),
    probleemomschrijving: getField(contact, FIELD_IDS.probleemomschrijving),
    prijs:                getField(contact, FIELD_IDS.prijs),
    opmerkingen:          getField(contact, FIELD_IDS.opmerkingen),
  };

  const gesprek = messages.map(m => `${m.richting === 'klant' ? 'Klant' : 'Monteur'}: ${m.tekst}`).join('\n');

  const prompt = `Je leest een WhatsApp/e-mail gesprek tussen een klant en Hetekraan (cv-ketel monteur).

Bestaande klantdata (lege waarden zijn onbekend):
${JSON.stringify(bestaand, null, 2)}

Gesprek:
${gesprek}

Extraheer alle nieuwe of verbeterde informatie uit het gesprek en retourneer ALLEEN een JSON-object met de velden die je kunt aanvullen of verbeteren. Laat velden weg die je niet kunt bepalen of die al correct zijn.

Beschikbare velden:
- straatnaam: straatnaam van het adres
- huisnummer: huisnummer (inclusief toevoeging)
- postcode: Nederlandse postcode (bijv. "1234 AB")
- woonplaats: plaatsnaam
- type_onderhoud: type werkzaamheden (bijv. "Storing cv-ketel", "Jaarlijks onderhoud", "Installatie")
- probleemomschrijving: wat is het probleem of wat moet er gebeuren
- prijs: genoemde prijs of prijsindicatie in euro's (alleen getal, bijv. "150")
- opmerkingen: overige relevante info (toegangscode, huisdieren, specifieke wensen)

Antwoord met alleen JSON, geen uitleg. Voorbeeld: {"straatnaam": "Keizersgracht", "huisnummer": "123", "postcode": "1015 CJ"}
Als er niets te extraheren valt, antwoord dan met: {}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await r.json();
  const text = data?.content?.[0]?.text?.trim();
  if (!text) return null;

  try {
    const extracted = JSON.parse(text);
    if (Object.keys(extracted).length === 0) return null;
    return extracted;
  } catch (_) {
    // Claude gaf soms tekst rondom de JSON — probeer te parsen
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    console.warn('Claude response kon niet geparsed worden:', text);
    return null;
  }
}

async function updateContact(contactId, extracted) {
  const customFields = Object.entries(extracted)
    .filter(([key]) => FIELD_IDS[key] && FIELD_IDS[key] !== 'YOUR_OPMERKINGEN_ID')
    .map(([key, value]) => ({ id: FIELD_IDS[key], field_value: String(value) }));

  if (!customFields.length) return;

  await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({ customFields })
  });
}

function getField(contact, fieldId) {
  if (!contact?.customFields) return '';
  const field = contact.customFields.find(f => f.id === fieldId);
  return field?.value || '';
}
