// api/webhook.js — GHL webhook ontvanger + Claude AI extractor
// Vercel Serverless Function (Node.js, ES Modules)

// ─── Config ────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // Vul in via Vercel env
const GHL_API_KEY       = process.env.GHL_API_KEY;       // Vul in via Vercel env
const GHL_BASE          = 'https://services.leadconnectorhq.com';

// ─── Custom field mapping (GHL field ID's) ──────────────────────────────────
const CUSTOM_FIELD_MAP = {
  postcode:                '3bCi5hL0rR9XGG33x2Gv',
  probleemomschrijving:    'BBcbPCNA9Eu0Kyi4U1LN',
  type_onderhoud:          'EXSQmlt7BqkXJMs8F3Qk',
  opmerkingen:             'LCIFALarX3WZI5jsBbDA',
  leeftijd_quooker:        'WLUAFmNnaVTCK4wdhqVg',
  straatnaam:              'ZwIMY4VPelG5rKROb5NR',
  huisnummer:              'co5Mr16rF6S6ay5hJOSJ',
  woonplaats:              'mFRQjlUppycMfyjENKF9',
  leeftijd_kraan:          'bYYyKo1Wyqxntc0UL2lY',
  datum_installatie:       'hiTe3Yi5TlxheJq4bLzy',
  datum_laatste_onderhoud: 'kYP2SCmhZ21Ig0aaLl5l',
  foto_ontvangen:          'D4eigmtm87z5Np8tZv8n',
  filmpje_ontvangen:       '6x5xXbNjkqLwD58eipi1',
  prijs:                   'HGjlT6ofaBiMz3j2HsXL',
};

// Toegestane waarden voor SINGLE_OPTIONS velden
const ALLOWED_TYPE_ONDERHOUD = ['onderhoud', 'reparatie', 'nieuwe quooker'];
const ALLOWED_JA_NEE         = ['ja', 'nee'];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Lees veilig een genest pad uit een object.
 * Bijv: safeGet(obj, 'a', 'b', 'c') → obj?.a?.b?.c
 */
function safeGet(obj, ...keys) {
  return keys.reduce((acc, key) => (acc != null && typeof acc === 'object' ? acc[key] : undefined), obj);
}

/**
 * Geef de eerste niet-lege string terug uit een lijst van kandidaatwaarden.
 * Accepteert zowel directe waarden als functies die een waarde teruggeven.
 */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    const value = typeof candidate === 'function' ? candidate() : candidate;
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

/**
 * Verwijder alle null/undefined/lege-string waarden zodat bestaande GHL data
 * niet overschreven wordt.
 */
function filterEmpty(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v != null && String(v).trim() !== '')
  );
}

/**
 * Bepaal of de webhook payload bewijs bevat van een foto-attachment.
 * Alleen "ja" als er aantoonbaar een media attachment aanwezig is.
 */
function detectFotoOntvangen(body) {
  const attachments = safeGet(body, 'message', 'attachments')
    || safeGet(body, 'attachments')
    || safeGet(body, 'triggerData', 'attachments')
    || [];
  if (!Array.isArray(attachments) || attachments.length === 0) return null;

  const hasPhoto = attachments.some(a => {
    const type = (a.type || a.mimeType || '').toLowerCase();
    return type.includes('image') || type.includes('photo') || type.includes('jpg')
      || type.includes('jpeg') || type.includes('png') || type.includes('webp');
  });
  return hasPhoto ? 'ja' : null;
}

/**
 * Bepaal of de webhook payload bewijs bevat van een video-attachment.
 */
function detectFilmpjeOntvangen(body) {
  const attachments = safeGet(body, 'message', 'attachments')
    || safeGet(body, 'attachments')
    || safeGet(body, 'triggerData', 'attachments')
    || [];
  if (!Array.isArray(attachments) || attachments.length === 0) return null;

  const hasVideo = attachments.some(a => {
    const type = (a.type || a.mimeType || '').toLowerCase();
    return type.includes('video') || type.includes('mp4') || type.includes('mov');
  });
  return hasVideo ? 'ja' : null;
}

// ─── Claude extractor ───────────────────────────────────────────────────────

async function extractWithClaude(messageText) {
  // Exacte prompt zoals opgegeven — niet aanpassen
  const prompt = `Je bent een CRM extractor voor Quooker-aanvragen.
Lees het WhatsApp-bericht en haal alleen informatie eruit die expliciet genoemd wordt.
Verzin niets.
Gebruik null voor onbekende velden.
Geef uitsluitend geldige JSON terug, zonder markdown, zonder uitleg, zonder extra tekst.
Regels:
- type_onderhoud mag alleen "onderhoud", "reparatie" of "nieuwe quooker" zijn.
- foto_ontvangen en filmpje_ontvangen mogen alleen "ja" of "nee" zijn.
- datumvelden alleen invullen als een duidelijke datum expliciet genoemd wordt.
- prijs alleen invullen als een concreet bedrag expliciet genoemd wordt.
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
      'x-api-key':          ANTHROPIC_API_KEY,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const rawText = safeGet(data, 'content', 0, 'text') || '';
  console.log('[Claude raw response]', rawText);

  // Veilig parsen — zoek JSON object in de response
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[Claude parse error] Geen JSON gevonden in response:', rawText);
    throw new Error('Claude gaf geen geldige JSON terug');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[Claude parse error] JSON.parse mislukt:', jsonMatch[0]);
    throw new Error('Claude JSON kon niet geparsed worden: ' + e.message);
  }
}

// ─── GHL contact updater ────────────────────────────────────────────────────

async function updateGhlContact(contactId, extracted, attachmentFoto, attachmentFilmpje) {
  // Valideer SINGLE_OPTIONS velden uit Claude
  const typeOnderhoud = ALLOWED_TYPE_ONDERHOUD.includes(extracted.type_onderhoud)
    ? extracted.type_onderhoud : null;

  // foto_ontvangen / filmpje_ontvangen: Claude bepaalt op basis van tekst.
  // Als er een attachment gedetecteerd is, overschrijft dat altijd naar "ja".
  const fotoRaw    = attachmentFoto === 'ja' ? 'ja' : extracted.foto_ontvangen;
  const filmpjeRaw = attachmentFilmpje === 'ja' ? 'ja' : extracted.filmpje_ontvangen;
  const fotoValue    = ALLOWED_JA_NEE.includes(fotoRaw)    ? fotoRaw    : null;
  const filmpjeValue = ALLOWED_JA_NEE.includes(filmpjeRaw) ? filmpjeRaw : null;

  // Bouw customFields array op — alleen velden met echte waarden
  const customFields = [];

  const addField = (fieldId, value) => {
    if (value != null && String(value).trim() !== '') {
      customFields.push({ id: fieldId, field_value: String(value).trim() });
    }
  };

  addField(CUSTOM_FIELD_MAP.postcode,                extracted.postcode);
  addField(CUSTOM_FIELD_MAP.probleemomschrijving,    extracted.probleemomschrijving);
  addField(CUSTOM_FIELD_MAP.type_onderhoud,          typeOnderhoud);
  addField(CUSTOM_FIELD_MAP.opmerkingen,             extracted.opmerkingen);
  addField(CUSTOM_FIELD_MAP.leeftijd_quooker,        extracted.leeftijd_quooker);
  addField(CUSTOM_FIELD_MAP.straatnaam,              extracted.straatnaam);
  addField(CUSTOM_FIELD_MAP.huisnummer,              extracted.huisnummer);
  addField(CUSTOM_FIELD_MAP.woonplaats,              extracted.woonplaats);
  addField(CUSTOM_FIELD_MAP.leeftijd_kraan,          extracted.leeftijd_kraan);
  addField(CUSTOM_FIELD_MAP.datum_installatie,       extracted.datum_installatie);
  addField(CUSTOM_FIELD_MAP.datum_laatste_onderhoud, extracted.datum_laatste_onderhoud);
  addField(CUSTOM_FIELD_MAP.foto_ontvangen,          fotoValue);
  addField(CUSTOM_FIELD_MAP.filmpje_ontvangen,       filmpjeValue);
  addField(CUSTOM_FIELD_MAP.prijs,                   extracted.prijs);

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

// ─── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── 1. Log volledige inkomende payload (tijdelijk voor debugging) ──────────
  console.log('[Webhook] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[Webhook] Body:',    JSON.stringify(req.body,    null, 2));

  const body = req.body || {};

  // ── 2. Haal contactId op (meerdere paden) ─────────────────────────────────
  const contactId = firstNonEmpty(
    safeGet(req.headers, 'contactid'),
    safeGet(body, 'contactId'),
    safeGet(body, 'contact_id'),
    safeGet(body, 'contact', 'id'),
  );
  console.log('[contactId gekozen]', contactId);

  if (!contactId) {
    return res.status(400).json({
      error:  'Geen contactId gevonden',
      debug:  { headerKeys: Object.keys(req.headers), bodyKeys: Object.keys(body) },
    });
  }

  // ── 3. Haal berichttekst op (meerdere paden) ──────────────────────────────
  const messageText = firstNonEmpty(
    safeGet(body, 'message', 'body'),
    safeGet(body, 'message', 'text'),
    safeGet(body, 'message'),
    safeGet(body, 'triggerData', 'message'),
    safeGet(body, 'triggerData', 'body'),
    safeGet(body, 'customData', 'message'),
  );
  console.log('[berichttekst gekozen]', messageText);

  if (!messageText) {
    return res.status(400).json({
      error:  'Geen berichttekst gevonden',
      debug:  {
        contactId,
        beschikbarePaden: {
          'message':             safeGet(body, 'message'),
          'message.body':        safeGet(body, 'message', 'body'),
          'triggerData.message': safeGet(body, 'triggerData', 'message'),
          'triggerData.body':    safeGet(body, 'triggerData', 'body'),
          'customData.message':  safeGet(body, 'customData', 'message'),
        },
      },
    });
  }

  // ── 4. Detecteer attachments (onafhankelijk van Claude) ───────────────────
  const fotoOntvangen    = detectFotoOntvangen(body);
  const filmpjeOntvangen = detectFilmpjeOntvangen(body);
  console.log('[Attachments] foto:', fotoOntvangen, '| filmpje:', filmpjeOntvangen);

  try {
    // ── 5. Stuur naar Claude voor extractie ───────────────────────────────
    const extracted = await extractWithClaude(messageText);
    console.log('[Claude extracted JSON]', JSON.stringify(extracted, null, 2));

    // ── 6. Update GHL contact ─────────────────────────────────────────────
    const ghlResult = await updateGhlContact(contactId, extracted, fotoOntvangen, filmpjeOntvangen);

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
