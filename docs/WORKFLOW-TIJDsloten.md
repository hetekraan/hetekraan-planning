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
   - Button `{{1}}` → **Boekings token** (pad na `/book/`)

Zo triggert de workflow **elke keer** dat er een nieuwe boekingslink wordt gegenereerd.

## Alternatief: alleen tag

- **Trigger:** Tag added → exact `stuur-tijdsloten` (kleine letters, geen spaties)
- Workflow moet **Published / Active** zijn
- Controleer **Execution history** in GHL na een test

## Dubbele berichten (tijdslot + ochtend)

- Onze server stuurt **geen** tweede vrij WhatsApp meer bij tijdsloten (alleen GHL-workflow). Dubbel = meestal **twee workflows** in GHL.
- **Tag vs. custom field:** de API zet standaard **alleen** de velden (Tijdslot 1/2, Boekings token). De tag `stuur-tijdsloten` wordt **niet** meer gezet, tenzij je in Vercel **`BOOKING_ADD_TAG=true`** zet. Zo voorkom je dat zowel “tag workflow” als “Boekings token workflow” tegelijk een template sturen.
- Controleer of je **ochtend-workflow** niet triggert op:
  - dezelfde tag als tijdsloten (`stuur-tijdsloten`), of
  - **hele map / alle custom fields** — kies exact **Boekings token** als trigger, niet “Quooker map” of “elk veld”.
- Ochtend-cron zet alleen tag `ochtend-melding` als **`MORNING_MESSAGES_ENABLED=true`** in Vercel staat. Zonder die env doet de cron **geen** tags (geen vroege ochtend-trigger door de server).

## Debug: komt er geen WhatsApp van de server?

1. **Network-response** van `POST /api/send-booking-invite` openen → `diag.whatsappAttempts[].detail` bevat meestal de **exacte GHL-fout** (scopes, template, nummer, …).
2. **Losse API-test** (zonder slots):  
   - Vercel → Environment → `BOOKING_DEBUG_SECRET` = willekeurige lange string.  
   - **Optie A** — `POST https://jouw-domein/api/health` (werkt ook als `booking-whatsapp-test` 404 geeft)  
   - **Optie B** — `POST https://jouw-domein/api/booking-whatsapp-test`  
   - Header: `x-booking-debug-secret: <zelfde waarde>`  
   - Body JSON: `{ "contactId": "…" }`  
   - Response: `attempts` per payload-variant (`message` vs `body`, met/zonder `locationId`).
3. **Vercel (optioneel)**  
   - `BOOKING_FALLBACK_TAG=true` — als de conversatie-API faalt, wordt tag `stuur-tijdsloten` getoggled zodat je **workflow** het alsnog kan sturen (niet tegelijk met een tweede workflow op custom field, anders dubbel).  
   - `BOOKING_SEND_DIRECT_WHATSAPP=false` — alleen als je **uitsluitend** GHL-workflow wilt (geen server-WhatsApp).

## Checklist

- [ ] WhatsApp Business gekoppeld in GHL
- [ ] Template **Approved** in Meta
- [ ] Contact heeft geldig **mobiel nummer** (WhatsApp)
- [ ] Custom fields bestaan: Tijdslot optie 1, Tijdslot optie 2, Boekings token
