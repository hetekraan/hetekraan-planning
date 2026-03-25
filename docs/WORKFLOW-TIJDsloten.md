# WhatsApp tijdsloten (GHL)

## Probleem: geen bericht na goedkeuring template

Vaak triggert **“Tag toegevoegd”** niet opnieuw als de tag al op het contact stond. De app verwijdert de tag nu eerst en zet hem 2 seconden later opnieuw.

## Aanbevolen: trigger op custom field

Betrouwbaarder dan alleen een tag:

1. **Automations → New Workflow**
2. **Trigger:** *Contact custom field updated* (of vergelijkbaar) → veld **Boekings token** (`whvgJ2ILKYukDlVj81rp`)
3. **Actie:** Send WhatsApp → jouw goedgekeurde template
4. Vul template-variabelen:
   - Body `{{1}}` → **Tijdslot optie 1**
   - Body `{{2}}` → **Tijdslot optie 2**
   - Button-URL: `https://jouw-domein.vercel.app/book?token={{1}}` met `{{1}}` = **Boekings token**, óf `https://…/book/{{1}}` (oude stijl — Vercel redirect naar `?token=`). API schrijft alleen de token in het veld; het voorvoegsel `…/book?token=` zet je vast in het Meta-template.

Zo triggert de workflow **elke keer** dat er een nieuwe boekingslink wordt gegenereerd.

**Zelfde token / geen trigger:** de API **wist het veld Boekings token eerst** (lege waarde), wacht kort (~450 ms), en schrijft daarna sloten + nieuwe token. Dat bootst “handmatig wissen + opnieuw sturen” na. Uitzetten met `BOOKING_TOKEN_CLEAR_BEFORE_SET=false`. Pauze aanpassen: `BOOKING_TOKEN_RESET_MS` (ms, max 5000).

**inviteIssuedAt** in de token-JSON blijft staan als extra uniciteit; sommige GHL-omgevingen negeren dat nog steeds voor triggers — dan helpt vooral de clear-stap.

## Alternatief: alleen tag

- **Trigger:** Tag added → exact `stuur-tijdsloten` (kleine letters, geen spaties)
- Workflow moet **Published / Active** zijn
- Controleer **Execution history** in GHL na een test

## Server en WhatsApp

- **`POST /api/send-booking-invite`** zet **custom fields** (en optioneel de tag) en schrijft het **mobiele nummer** als **+31…** mee. **Geen** WhatsApp via de GHL Conversations API — alleen workflows met **goedgekeurde templates**.
- **Bevestiging na boeken** (`/api/confirm-booking`): zet o.a. **tijdafspraak** en pulst tag **`boeking-bevestigd`** voor je template-workflow.

## Dubbele berichten (tijdslot + ochtend)

- Dubbel = meestal **twee workflows** in GHL die allebei op hetzelfde moment reageren.
- **Tag vs. custom field:** de API zet standaard **alleen** de velden (Tijdslot 1/2, Boekings token). De tag `stuur-tijdsloten` wordt **niet** meer gezet, tenzij je in Vercel **`BOOKING_ADD_TAG=true`** zet. Zo voorkom je dat zowel “tag workflow” als “Boekings token workflow” tegelijk een template sturen.
- Controleer of je **ochtend-workflow** niet triggert op:
  - dezelfde tag als tijdsloten (`stuur-tijdsloten`), of
  - **hele map / alle custom fields** — kies exact **Boekings token** als trigger, niet “Quooker map” of “elk veld”.
- Ochtend-cron zet alleen tag `ochtend-melding` als **`MORNING_MESSAGES_ENABLED=true`** in Vercel staat. Zonder die env doet de cron **geen** tags (geen vroege ochtend-trigger door de server).

## Debug: geen WhatsApp na “Stuur tijdsloten”

1. **Network-response** van `POST /api/send-booking-invite`: `workflowReady` moet `true` zijn en `diag.fieldsPut` `true`. Zo niet: GHL PUT / API-key / field-IDs.
2. **GHL:** workflow **Published**, trigger op **Boekings token** (of tag + `BOOKING_ADD_TAG=true`), **Execution history**, template goedgekeurd, contact **+31** mobiel.
3. **`GET /api/health`** — alleen GHL/OpenRouter bereikbaarheid; geen WhatsApp-test meer via POST.

## Checklist

- [ ] WhatsApp Business gekoppeld in GHL
- [ ] Template **Approved** in Meta
- [ ] Contact heeft geldig **mobiel nummer** (WhatsApp)
- [ ] Custom fields bestaan: Tijdslot optie 1, Tijdslot optie 2, Boekings token
