// api/webhook.js — GHL webhook ontvanger + Claude AI extractor
// Vercel Serverless Function (Node.js, ES Modules)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_API_KEY       = process.env.GHL_API_KEY;
const GHL_BASE          = 'https://services.leadconnectorhq.com';

const CUSTOM_FIELD_MAP = {
  postcode:                '3bCi5hL0rR9XGG33x2Gv',
  filmpje_ontvangen:       '6x5xXbNjkqLwD58eipi1',
  probleemomschrijving:    'BBcbPCNA9Eu0Kyi4U1LN',
  type_onderhoud:          'EXSQmlt7BqkXJMs8F3Qk',
  prijs:                   'HGjlT6ofaBiMz3j2HsXL',
  opmerkingen:             'LCIFALarX3WZI5jsBbDA',
  leeftijd_quooker:        'WLUAFmNnaVTCK4wdhqVg',
  straatnaam:              'ZwIMY4VPelG5rKROb5NR',
  leeftijd_kraan:          'bYYyKo1Wyqxntc0UL2lY',
  huisnummer:              'co5Mr16rF6S6ay5hJOSJ',
  fotos:                   'hE5KrXL5baV00uyH6Ofy',
  filmpje:                 '56SngmGWQuhulwEhioA3',
  datum_installatie:       'hiTe3Yi5TlxheJq4bLzy',
  datum_laatste_onderhoud: 'kYP2SCmhZ21Ig0aaLl5l',
  woonplaats:              'mFRQjlUppycMfyjENKF9',
  foto_ontvangen:          'D4eigmtm87z5Np8tZv8n',
};

const ALLOWED_TYPE_ONDERHOUD = ['onderhoud', 'reparatie', 'nieuwe quooker'];
const ALLOWED_JA_NEE         = ['ja', 'nee'];

function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    const v = typeof c === 'function' ? c() : c;
    if (v != null && typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

async function extractWithClaude(messageText) {
  const prompt = `Je bent een CRM extractor voor Quooker-aanvragen.
Lees het WhatsApp-bericht en haal alleen informatie eruit die expliciet genoemd wordt.
Verzin niets.
Gebruik null voor onbekende velden.
Geef uitsluitend geldige JSON terug, zonder markdown, zonder uitleg, zonder extra tekst.
Regels:
- type_onderhoud mag alleen "onderhoud", "reparatie" of "nieuwe quooker" zijn.
- foto_ontvangen en filmpje_ontvangen mogen alleen "ja" of "nee" zijn, en alleen als dat expliciet zeker is.
- datumvelden alleen invullen als een duidelijke datum expliciet genoemd wordt.
- prijs alleen invullen als een concreet bedrag expliciet genoemd wordt.
- Gebruik korte, schone tekstwaarden.
Schema:
{
  "postcode": null,
  "probleemomschrijving": null,
  "type_onderhoud": null,
  "opmerkingen": null,
  "leeftijd_quooker": null,
  "straatnaam": null,
  "huisnummer": null,
  "woonplaats": null,
  "leeftijd_kraan": null,
  "datum_installatie": null,
  "datum_laatste_onderhoud": null,
  "foto_ontvangen": null,
  "filmpje_ontvangen": null,
  "prijs": null
}
WhatsApp-bericht:
${messageText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const rawText = data?.content?.[0]?.text || '';
  console.log('[Claude raw response]', rawText);

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude gaf geen geldige JSON terug: ' + rawText);

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Claude JSON parse mislukt: ' + e.message);
  }
}

async function updateGhlContact(contactId, extracted) {
  const customFields = [];

  const add = (fieldId, value, allowedValues) => {
    if (value == null || String(value).trim() === '') return;
    const v = String(value).trim();
    if (allowedValues && !allowedValues.includes(v)) return;
    customFields.push({ id: fieldId, field_value: v });
  };

  add(CUSTOM_FIELD_MAP.postcode,                extracted.postcode);
  add(CUSTOM_FIELD_MAP.probleemomschrijving,    extracted.probleemomschrijving);
  add(CUSTOM_FIELD_MAP.type_onderhoud,          extracted.type_onderhoud,    ALLOWED_TYPE_ONDERHOUD);
  add(CUSTOM_FIELD_MAP.opmerkingen,             extracted.opmerkingen);
  add(CUSTOM_FIELD_MAP.leeftijd_quooker,        extracted.leeftijd_quooker);
  add(CUSTOM_FIELD_MAP.straatnaam,              extracted.straatnaam);
  add(CUSTOM_FIELD_MAP.huisnummer,              extracted.huisnummer);
  add(CUSTOM_FIELD_MAP.woonplaats,              extracted.woonplaats);
  add(CUSTOM_FIELD_MAP.leeftijd_kraan,          extracted.leeftijd_kraan);
  add(CUSTOM_FIELD_MAP.datum_installatie,       extracted.datum_installatie);
  add(CUSTOM_FIELD_MAP.datum_laatste_onderhoud, extracted.datum_laatste_onderhoud);
  add(CUSTOM_FIELD_MAP.foto_ontvangen,          extracted.foto_ontvangen,    ALLOWED_JA_NEE);
  add(CUSTOM_FIELD_MAP.filmpje_ontvangen,       extracted.filmpje_ontvangen, ALLOWED_JA_NEE);
  add(CUSTOM_FIELD_MAP.prijs,                   extracted.prijs);

  if (customFields.length === 0) {
    console.log('[GHL update] Geen velden om bij te werken — skip.');
    return null;
  }

  const payload = { customFields };
  console.log('[GHL update payload]', JSON.stringify(payload, null, 2));

  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type':  'application/json',
      'Version':       '2021-04-15',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await res.text();
  console.log('[GHL response status]', res.status);
  console.log('[GHL response body]',   responseText.slice(0, 500));

  if (!res.ok) throw new Error(`GHL update mislukt: HTTP ${res.status} — ${responseText.slice(0, 200)}`);

  try { return JSON.parse(responseText); } catch (_) { return responseText; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  console.log('[Webhook] Body:', JSON.stringify(body, null, 2));

  // ── 1. contactId ──────────────────────────────────────────────────────────
  const contactId = firstNonEmpty(
    req.headers['contactid'],
    body.contactId,
    body.contact_id,
    body.contact?.id,
  );
  console.log('[contactId]', contactId);

  if (!contactId) {
    return res.status(400).json({
      error:    'Geen contactId gevonden',
      debug:    { headerKeys: Object.keys(req.headers), bodyKeys: Object.keys(body) },
    });
  }

  // ── 2. berichttekst direct uit de webhook body ────────────────────────────
  const messageText = firstNonEmpty(
    body.message?.body,
    body.message?.text,
    typeof body.message === 'string' ? body.message : null,
    body.triggerData?.message,
    body.triggerData?.body,
    body.customData?.messageText,
    body.customData?.lastMessage,
    body.customData?.message,
  );
  console.log('[messageText]', messageText);

  if (!messageText) {
    return res.status(400).json({
      error: 'Geen berichttekst gevonden in webhook body',
      debug: {
        contactId,
        'message':                body.message,
        'message.body':           body.message?.body,
        'triggerData.message':    body.triggerData?.message,
        'triggerData.body':       body.triggerData?.body,
        'customData.messageText': body.customData?.messageText,
        'customData.lastMessage': body.customData?.lastMessage,
        'customData.message':     body.customData?.message,
      },
    });
  }

  try {
    // ── 3. Claude extractie ───────────────────────────────────────────────
    const extracted = await extractWithClaude(messageText);
    console.log('[Claude extracted JSON]', JSON.stringify(extracted, null, 2));

    // ── 4. GHL contact updaten ────────────────────────────────────────────
    const ghlResult = await updateGhlContact(contactId, extracted);

    return res.status(200).json({
      ok:         true,
      contactId,
      extracted,
      ghlUpdated: ghlResult != null,
    });

  } catch (err) {
    console.error('[Webhook error]', err.message, err.stack);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
