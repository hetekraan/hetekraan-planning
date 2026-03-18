// api/webhook.js — GHL webhook ontvanger + Claude AI chat parser
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Alle custom velden die we willen opslaan (key = GHL contact.{key})
// FILE_UPLOAD velden (fotos, filmpje) slaan we niet op via tekst
const TEXT_FIELDS = [
  'woonplaats', 'straatnaam', 'huisnummer', 'postcode', 'volledige_adres',
  'type_onderhoud', 'probleemomschrijving', 'type_probleem',
  'leeftijd_kraan', 'leeftijd_quooker', 'laatste_onderhoudsbeurt',
  'knippert', 'knippert_aantal',
  'foto_ontvangen', 'filmpje_ontvangen',
  'opmerkingen', 'prijs',
];

// Velden die via het standaard contact object gaan (niet customFields)
const STANDARD_FIELDS = ['email'];

let cachedFieldMap = null;

async function getFieldMap() {
  if (cachedFieldMap) return cachedFieldMap;
  const res = await fetch(`${GHL_BASE}/locations/${GHL_LOCATION_ID}/customFields`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  if (!res.ok) {
    console.error('getFieldMap HTTP error:', res.status, await res.text());
    return {};
  }
  const data = await res.json();
  const fields = data?.customFields || data?.list || [];
  const map = {};
  for (const f of fields) {
    const rawKey = f.fieldKey || f.key || '';
    const key = rawKey.replace(/^contact\./, '');
    if (key) map[key] = f.id;
  }
  console.log('Veld-ID mapping geladen:', JSON.stringify(map));
  cachedFieldMap = map;
  return map;
}

async function ensureCustomFields(fieldMap) {
  // Velden die nog niet bestaan in GHL aanmaken
  const missing = [
    { name: 'Volledige Adres', key: 'volledige_adres', dataType: 'TEXT' },
    { name: 'Type Probleem',   key: 'type_probleem',   dataType: 'TEXT' },
    { name: 'Knippert',        key: 'knippert',        dataType: 'TEXT' },
    { name: 'Knippert Aantal', key: 'knippert_aantal', dataType: 'TEXT' },
    { name: 'Laatste Onderhoudsbeurt', key: 'laatste_onderhoudsbeurt', dataType: 'TEXT' },
  ].filter(f => !fieldMap[f.key]);

  for (const f of missing) {
    try {
      const res = await fetch(`${GHL_BASE}/locations/${GHL_LOCATION_ID}/customFields`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-04-15',
        },
        body: JSON.stringify({ name: f.name, dataType: f.dataType }),
      });
      const data = await res.json();
      const newId = data?.customField?.id || data?.id;
      if (newId) {
        fieldMap[f.key] = newId;
        console.log(`Custom field aangemaakt: ${f.key} → ${newId}`);
      } else {
        console.error(`Aanmaken ${f.key} mislukt:`, JSON.stringify(data));
      }
    } catch (e) {
      console.error(`Fout bij aanmaken ${f.key}:`, e.message);
    }
  }
  // Reset cache zodat volgende request de nieuwe velden oppikt
  cachedFieldMap = null;
  return fieldMap;
}

async function getContact(contactId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await res.json();
  return data?.contact || data;
}

async function getLatestConversationId(contactId) {
  const res = await fetch(`${GHL_BASE}/conversations/search?contactId=${contactId}&limit=1`, {
    headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await res.json();
  const conversations = data?.conversations || data?.list || [];
  return conversations[0]?.id || null;
}

async function getConversationMessages(conversationId) {
  const urls = [
    `${GHL_BASE}/conversations/${conversationId}/messages?limit=50`,
    `${GHL_BASE}/conversations/messages?conversationId=${conversationId}&limit=50`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-04-15' }
      });
      const data = await res.json();
      const msgs = data?.messages || data?.list || [];
      if (msgs.length > 0) return msgs;
    } catch (_) {}
  }
  return [];
}

async function parseWithClaude(convoText, contact) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Je analyseert een WhatsApp gesprek met een klant van Hetekraan.nl — een Quooker installatiebedrijf.
Extraheer ALLEEN informatie die expliciet in het gesprek staat. Gok nooit. Laat velden leeg als niet vermeld.
Geef uitsluitend een JSON object terug, zonder uitleg.

Huidige klantgegevens:
Naam: ${(contact.firstName || '') + ' ' + (contact.lastName || '')}
Email: ${contact.email || ''}
Telefoon: ${contact.phone || ''}

Gesprek (nieuwste onderaan):
${convoText}

Geef dit exacte JSON formaat terug:
{
  "woonplaats": "",
  "straatnaam": "",
  "huisnummer": "",
  "postcode": "",
  "volledige_adres": "",
  "type_onderhoud": "",
  "probleemomschrijving": "",
  "type_probleem": "",
  "leeftijd_kraan": "",
  "leeftijd_quooker": "",
  "laatste_onderhoudsbeurt": "",
  "knippert": "",
  "knippert_aantal": "",
  "foto_ontvangen": "",
  "filmpje_ontvangen": "",
  "opmerkingen": "",
  "prijs": "",
  "email": ""
}

Regels:
- type_onderhoud: alleen "reparatie", "onderhoud" of "nieuwe_quooker"
- type_probleem: kort specifiek probleem, bijv. "lekkende quooker", "knippert 4x", "geen water"
- knippert: "ja" of "nee"
- knippert_aantal: "2" of "4"
- foto_ontvangen: "ja" als klant foto's heeft gestuurd, anders "nee" of leeg
- filmpje_ontvangen: "ja" als klant een filmpje heeft gestuurd, anders "nee" of leeg
- postcode: formaat 1234AB (zonder spatie)
- leeftijd_kraan / leeftijd_quooker: alleen het getal in jaren
- volledige_adres: combineer straat + huisnummer + postcode + woonplaats als alles bekend is
- prijs: alleen het getal, geen euroteken
- email: e-mailadres als vermeld in het gesprek`
      }]
    })
  });
  const data = await res.json();
  const text = data?.content?.[0]?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try { return match ? JSON.parse(match[0]) : {}; }
  catch (_) { return {}; }
}

async function updateContact(contactId, extracted) {
  let fieldMap = await getFieldMap();
  fieldMap = await ensureCustomFields(fieldMap);

  // Custom fields
  const customFields = TEXT_FIELDS
    .filter(key => extracted[key] && String(extracted[key]).trim() && fieldMap[key])
    .map(key => ({ id: fieldMap[key], field_value: String(extracted[key]).trim() }));

  // Standaard velden (email)
  const standardUpdate = {};
  for (const key of STANDARD_FIELDS) {
    if (extracted[key] && String(extracted[key]).trim()) {
      standardUpdate[key] = String(extracted[key]).trim();
    }
  }

  const body = { ...standardUpdate };
  if (customFields.length > 0) body.customFields = customFields;

  if (Object.keys(body).length === 0) {
    console.log('Niets te updaten. extracted:', JSON.stringify(extracted));
    return 0;
  }

  console.log('GHL update body:', JSON.stringify(body));

  const updateRes = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
    },
    body: JSON.stringify(body),
  });
  const updateData = await updateRes.json();
  console.log('GHL update response status:', updateRes.status, JSON.stringify(updateData).slice(0, 300));

  return customFields.length + Object.keys(standardUpdate).length;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const respond = (data) => res.status(200).json(data);
  const body = req.body;

  const contactId = body?.contactId || body?.contact_id;
  const conversationId = body?.conversationId;

  console.log('Webhook ontvangen:', JSON.stringify({ contactId, conversationId, keys: Object.keys(body || {}) }));

  console.log('Env check — ANTHROPIC_API_KEY:', !!ANTHROPIC_API_KEY, '| GHL_LOCATION_ID:', !!GHL_LOCATION_ID, '| GHL_API_KEY:', !!GHL_API_KEY);
  if (!contactId) { console.log('Skip: missing contactId'); return respond({ ok: true, skipped: 'missing contactId' }); }
  if (!ANTHROPIC_API_KEY) { console.error('STOP: ANTHROPIC_API_KEY niet ingesteld'); return respond({ ok: false, error: 'ANTHROPIC_API_KEY niet ingesteld' }); }
  if (!GHL_LOCATION_ID) { console.error('STOP: GHL_LOCATION_ID niet ingesteld'); return respond({ ok: false, error: 'GHL_LOCATION_ID niet ingesteld' }); }

  try {
    // Contact info: gebruik payload data als beschikbaar, anders API call
    const payloadContact = body?.contact || {};
    const contactFromPayload = {
      firstName: body?.first_name || payloadContact?.firstName || payloadContact?.first_name || '',
      lastName: body?.last_name || payloadContact?.lastName || payloadContact?.last_name || '',
      email: payloadContact?.email || '',
      phone: body?.phone || payloadContact?.phone || '',
    };

    // Huidig bericht uit payload
    const payloadMessage = body?.message || {};
    const payloadMessageText = payloadMessage?.body || payloadMessage?.text || payloadMessage?.messageBody || '';
    const payloadMessageDir = (payloadMessage?.direction === 'inbound' || payloadMessage?.type === 'inbound') ? 'Klant' : 'Bot';
    console.log('Payload message:', JSON.stringify({ text: payloadMessageText, dir: payloadMessageDir }));

    // Probeer conversation history op te halen
    const resolvedConversationId = conversationId || await getLatestConversationId(contactId);
    console.log('Conversation ID gevonden:', resolvedConversationId);

    let convoLines = [];

    if (resolvedConversationId) {
      const [contactFull, messages] = await Promise.all([
        getContact(contactId),
        getConversationMessages(resolvedConversationId),
      ]);
      // Gebruik API contact als die meer info heeft
      if (contactFull?.email) contactFromPayload.email = contactFull.email;
      if (contactFull?.firstName) contactFromPayload.firstName = contactFull.firstName;
      if (contactFull?.lastName) contactFromPayload.lastName = contactFull.lastName;

      convoLines = messages
        .slice(-30)
        .map(m => {
          const text = m.body || m.text || m.messageBody || '';
          const dir = (m.direction === 'inbound' || m.messageType === 'inbound') ? 'Klant' : 'Bot';
          return text ? `${dir}: ${text}` : null;
        })
        .filter(Boolean);
      console.log(`Conversation messages geladen: ${convoLines.length}`);
    }

    // Als geen history, gebruik dan huidig bericht uit payload
    if (convoLines.length === 0 && payloadMessageText) {
      convoLines = [`${payloadMessageDir}: ${payloadMessageText}`];
      console.log('Fallback: gebruik payload message als gesprek');
    }

    if (convoLines.length === 0) return respond({ ok: true, skipped: 'no messages found anywhere' });

    const convoText = convoLines.join('\n');
    const contact = contactFromPayload;

    const extracted = await parseWithClaude(convoText, contact);
    console.log('Claude extracted:', JSON.stringify(extracted));

    const updated = await updateContact(contactId, extracted);

    return respond({ ok: true, contactId, fieldsUpdated: updated, extracted });

  } catch (err) {
    console.error('Webhook error:', err.message, err.stack);
    return respond({ ok: true, error: err.message });
  }
}
