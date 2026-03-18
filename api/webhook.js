// api/webhook.js — GHL webhook ontvanger + Claude AI chat parser
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const FIELD_IDS = {
  straatnaam:          'ZwIMY4VPelG5rKROb5NR',
  huisnummer:          'co5Mr16rF6S6ay5hJOSJ',
  postcode:            '3bCi5hL0rR9XGG33x2Gv',
  woonplaats:          'mFRQjlUppycMfyjENKF9',
  type_onderhoud:      'EXSQmlt7BqkXJMs8F3Qk',
  probleemomschrijving:'BBcbPCNA9Eu0Kyi4U1LN',
  prijs:               'HGjlT6ofaBiMz3j2HsXL',
};

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
    `${GHL_BASE}/conversations/${conversationId}/messages?limit=30`,
    `${GHL_BASE}/conversations/messages?conversationId=${conversationId}&limit=30`,
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
        content: `Je analyseert een gesprek met een klant van een cv-ketel/verwarmingsbedrijf in Nederland.
Extraheer ALLEEN informatie die expliciet in het gesprek wordt genoemd. Gok nooit.
Geef uitsluitend een JSON object terug zonder uitleg.

Huidige klantgegevens:
Naam: ${(contact.firstName || '') + ' ' + (contact.lastName || '')}
Email: ${contact.email || ''}
Telefoon: ${contact.phone || ''}

Gesprek (nieuwste onderaan):
${convoText}

Geef dit exacte JSON formaat terug. Laat velden leeg als niet expliciet vermeld:
{
  "straatnaam": "",
  "huisnummer": "",
  "postcode": "",
  "woonplaats": "",
  "type_onderhoud": "",
  "probleemomschrijving": "",
  "prijs": "",
  "opmerkingen": ""
}

Regels:
- type_onderhoud: alleen "reparatie", "onderhoud", "installatie" of leeg
- postcode: formaat 1234AB (zonder spatie)
- prijs: alleen het getal, geen euroteken
- opmerkingen: bijzonderheden, wensen, of afspraken die niet in andere velden passen`
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
  const customFields = Object.entries(FIELD_IDS)
    .filter(([key, id]) => extracted[key] && String(extracted[key]).trim())
    .map(([key, id]) => ({ id, field_value: String(extracted[key]).trim() }));

  if (customFields.length === 0) return 0;

  await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
    },
    body: JSON.stringify({ customFields }),
  });

  return customFields.length;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const respond = (data) => res.status(200).json(data);

  const body = req.body;

  // GHL Automation webhooks gebruiken snake_case, native webhooks camelCase
  const contactId = body?.contactId || body?.contact_id;
  const conversationId = body?.conversationId;

  console.log('Webhook ontvangen:', JSON.stringify({ type: body?.type, contactId, conversationId, keys: Object.keys(body || {}) }));

  if (!contactId) {
    return respond({ ok: true, skipped: 'missing contactId' });
  }

  if (!ANTHROPIC_API_KEY) {
    return respond({ ok: false, error: 'ANTHROPIC_API_KEY niet ingesteld' });
  }

  try {
    // Haal conversationId op via API als die niet in de webhook zat
    const resolvedConversationId = conversationId || await getLatestConversationId(contactId);

    if (!resolvedConversationId) {
      return respond({ ok: true, skipped: 'no conversation found for contact' });
    }

    const [contact, messages] = await Promise.all([
      getContact(contactId),
      getConversationMessages(resolvedConversationId),
    ]);

    if (messages.length === 0) return respond({ ok: true, skipped: 'no messages' });

    // Bouw gesprekstekst op (klant vs bedrijf)
    const convoText = messages
      .slice(-25)
      .map(m => {
        const body = m.body || m.text || m.messageBody || '';
        const dir = (m.direction === 'inbound' || m.messageType === 'inbound') ? 'Klant' : 'Bedrijf';
        return body ? `${dir}: ${body}` : null;
      })
      .filter(Boolean)
      .join('\n');

    if (!convoText.trim()) return respond({ ok: true, skipped: 'empty conversation' });

    const extracted = await parseWithClaude(convoText, contact);
    const updated = await updateContact(contactId, extracted);

    console.log(`Webhook: contact ${contactId}, ${updated} velden bijgewerkt`, extracted);
    return respond({ ok: true, contactId, fieldsUpdated: updated, extracted });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return respond({ ok: true, error: err.message });
  }
}
