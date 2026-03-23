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

## Checklist

- [ ] WhatsApp Business gekoppeld in GHL
- [ ] Template **Approved** in Meta
- [ ] Contact heeft geldig **mobiel nummer** (WhatsApp)
- [ ] Custom fields bestaan: Tijdslot optie 1, Tijdslot optie 2, Boekings token
