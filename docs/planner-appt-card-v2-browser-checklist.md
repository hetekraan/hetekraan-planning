# Browser-checklist: afspraakkaart layout v2 (vanilla planner)

Lokaal uitvoeren vóór push. Gebruik een **niet-Jerry** account voor v2; **Jerry** (`body.user-jerry`) voor regressie oude kaart.

**Start:** `npm run dev` (of je gebruikelijke static host) → planner openen met echte of testdata.

---

## Voorbereiding

- [ ] Desktopvenster **≥ 1180px** (of je productie-breekpunt) voor v2-desktop checks.
- [ ] Smal venster **≤ 639px** en tablet **640px–1179px** minstens één keer doorlopen.
- [ ] Zorg voor minstens één afspraak per status: **ingepland**, **onderweg**, **klaar**.

---

## Checks (vink af na verificatie)

### 1. Te doen-kaart (`ingepland`, niet-Jerry)

- [ ] Kaart heeft class `appt-card--layout-v2` en `appt-card--todo` (via devtools).
- [ ] Zichtbaar: routenummer, adres, klantregel, type-pill (of leeg logisch), **Prijs**, **Onderweg →**, ⋯.
- [ ] Visueel: neutrale linkerrand, geen “✓ Klaar”-badge rechtsboven (v2 verbergt `done::after`).

### 2. Onderweg-kaart (niet-Jerry)

- [ ] Rand/achtergrond amber (warm), pill “Onderweg”.
- [ ] **Klaar**-knop (groene stijl) + **Prijs** + ⋯ zichtbaar; geen “Onderweg →” meer.

### 3. Klaar-kaart (niet-Jerry)

- [ ] Groene state / “Klaar”-pill; geen primaire “Onderweg”/“Klaar”-cta op de kaart (alleen Prijs + menu waar van toepassing).
- [ ] Prijs/afgeronde flow: `complete-bar` en factuur-UI nog bereikbaar zoals voorheen.

### 4. ⋯-menu desktop (niet-Jerry, breed scherm)

- [ ] Klik op ⋯ opent dropdown (`is-open` op `#mob-menu-<domId>`).
- [ ] Menu valt **niet** weg onder de kaart (niet afgeknipt); items klikbaar.
- [ ] Klik buiten menu sluit het; Escape sluit ook.

### 5. Prijs-knop

- [ ] **Prijs** opent prijsoverzicht (`togglePrijs` / touch-overlay op smal scherm zoals eerder).
- [ ] Paneel sluit weer zonder layout-breuk.

### 6. Onderweg →

- [ ] Modal/flow “onderweg” verschijnt; na bevestiging status **onderweg** en kaart ziet er onderweg uit.

### 7. Klaar-flow

- [ ] Vanaf onderweg: **Klaar** scrollt/opent prijsblok waar van toepassing; **Bevestig klaar** / bestaande `confirmDone`-flow nog intact (geen JS-errors in console).

### 8. Jerry-account

- [ ] Inloggen als Jerry: **geen** `appt-card--layout-v2`; oude layout met **iconenstrip** bovenin; zelfde acties werken.

### 9. Mobiel / tablet

- [ ] ≤639px: footer-rij en knoppen niet overlappend/onbruikbaar; ⋯ werkt.
- [ ] 640–1179px: kaart geen “kapotte” grid (volle breedte, geen afgesneden content).

### 10. Negatieve prijsregel

- [ ] Voeg (test) een **negatieve** prijsregel toe in het prijsoverzicht: regels blijven opslaan/berekenen; kaart-header gedraagt zich zoals voorheen (euro alleen bij `total > 0`, anders label/lege sync volgens bestaande logica).

---

## Klaar-signalering

- Als **alle** items afgevinkt en geen visuele/JS-issues: lokaal **`npm test`** + **`npm run build`** nog één keer draaien, daarna veilig pushen (volgens jullie releaseproces).
- Bij afwijkingen: alleen gerichte fixes in `index.html`, daarna opnieuw `npm test` + `npm run build`.
