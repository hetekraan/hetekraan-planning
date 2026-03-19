// api/webhook.js
// Tijdelijke debugversie: ontvangt GHL webhook, haalt berichttekst op,
// stuurt die naar Anthropic Claude, parsed JSON, en geeft dat terug.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  try {
    console.log("=== WEBHOOK HIT ===");
    console.log("[METHOD]", req.method);
    console.log("[BODY]", JSON.stringify(req.body, null, 2));
    console.log("[HAS ANTHROPIC KEY]", !!ANTHROPIC_API_KEY);

    const messageText =
      req.body?.message?.body ||
      req.body?.message ||
      req.body?.triggerData?.message ||
      req.body?.triggerData?.body ||
      req.body?.customData?.messageText ||
      req.body?.customData?.lastMessage ||
      "";

    console.log("[MESSAGE TEXT]", messageText);

    if (!messageText || !String(messageText).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Geen berichttekst gevonden in webhook payload"
      });
    }

    const extractorPrompt = `
Je bent een CRM extractor voor Quooker-aanvragen.

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
${messageText}
`.trim();

    const anthropicBody = {
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: extractorPrompt
        }
      ]
    };

    console.log("[ANTHROPIC REQUEST BODY]", JSON.stringify(anthropicBody, null, 2));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(anthropicBody)
    });

    console.log("[ANTHROPIC HTTP STATUS]", response.status);

    const rawResponseText = await response.text();
    console.log("[ANTHROPIC RAW TEXT RESPONSE]", rawResponseText);

    let anthropicJson;
    try {
      anthropicJson = JSON.parse(rawResponseText);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "Anthropic response was geen geldige JSON",
        rawResponseText
      });
    }

    console.log("[ANTHROPIC PARSED RESPONSE JSON]", JSON.stringify(anthropicJson, null, 2));

    const textBlocks = Array.isArray(anthropicJson?.content)
      ? anthropicJson.content
          .filter(block => block?.type === "text")
          .map(block => block?.text || "")
      : [];

    let modelText = textBlocks.join("").trim();

    console.log("[ANTHROPIC EXTRACTED TEXT]", modelText);

    if (!modelText) {
      return res.status(500).json({
        ok: false,
        error: "Anthropic response bevatte geen tekstcontent",
        anthropicJson
      });
    }

    modelText = modelText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    console.log("[ANTHROPIC CLEANED TEXT]", modelText);

    let parsed;
    try {
      parsed = JSON.parse(modelText);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: `Claude gaf geen geldige JSON terug: ${modelText}`
      });
    }

    console.log("[FINAL PARSED JSON]", JSON.stringify(parsed, null, 2));

    return res.status(200).json({
      ok: true,
      messageText,
      parsed
    });
  } catch (err) {
    console.error("[UNCAUGHT ERROR]", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "Onbekende serverfout"
    });
  }
}
