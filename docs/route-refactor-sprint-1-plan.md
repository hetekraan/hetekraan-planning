# Route Refactor Sprint 1 Plan

Status: Fase 1A plan. Nog geen route-logica wijzigen voordat dit plan is goedgekeurd.

Doel van sprint 1: route-divergentie tussen gebruikers stoppen. De centrale Redis route-lock (`hk:route_lock:{locationId}:{dateStr}`) wordt leidend voor de bevestigde route. Browser `localStorage` mag alleen nog een lokaal concept of read-through cache bevatten, nooit de bevestigde bron van waarheid.

Feature flag / noodrem: alle nieuwe sprint-1 route-source-of-truth wijzigingen komen achter `ROUTE_REFACTOR_ENABLED`, default `true`. Als deze env var op `false` staat, valt het systeem terug op het oude gedrag waarbij lokale route-state de route nog kan overrulen. Dit is alleen bedoeld als tijdelijke rollback-optie bij productieproblemen.

## 1. Hernoeming localStorage keys

### Voorstel nieuwe namen

- `hk_route_confirmed_order_{dateStr}` wordt `hk_route_local_draft_order_{dateStr}`.
  - Reden: deze key wordt nu ook gezet na optimaliseren en drag/drop vóór `Bevestig route`, dus "confirmed" is misleidend.
  - Inhoud blijft `{ savedAt, contactIdsOrder }`, maar betekenis wordt: lokaal concept dat alleen deze browser ziet.
- `hk_route_times_{dateStr}` blijft als key voor read-through cache en draft tijden, maar de betekenis wordt expliciet opgesplitst in de payload:
  - `localDraft`: lokale conceptvolgorde/tijden (`byContactId`, `contactIdsOrder`, `savedAt`).
  - `serverCache`: optionele kopie van de laatst opgehaalde centrale lock voor snelle weergave, alleen geldig als `revision` en `orderChecksum` overeenkomen met de serverresponse.
- `routeOperationalLock` in de `hk_route_times_*` payload wordt niet meer gebruikt als lock/source-of-truth en wordt vervangen door `routeLocalDraft`.
  - Reden: "operational lock" suggereert dat de route centraal bevestigd is, terwijl de inhoud lokaal kan zijn.
  - Nieuwe betekenis: `routeLocalDraft: { savedAt, contactIdsOrder, etasByContactId, internalFixedStartByContactId }`.

### Geraakte files

- `index.html`
  - `confirmedRouteOrderKey()`, `readConfirmedRouteOrder()`, `saveConfirmedRouteOrder()`, `clearConfirmedRouteOrder()`.
  - `syncCentralRouteLockState()`, `applyRouteSnapshot()`, `getRouteStopsForSidebar()`, `unlockRoute()`, drag/drop handler en route-panel status.
- `public/app/planner-route-snapshot.js`
  - Leest/schrijft nu `routeOperationalLock` in `hk_route_times_*`.
  - Moet `routeLocalDraft` en `serverCache` normaliseren en `routeOperationalLock` alleen nog als legacy input migreren.
- `public/app/planner-route-local-ui.js`
  - Leest nu `routeOperationalLock` om lokale UI te verbergen.
  - Moet lokale draft expliciet tonen als concept, niet als lock.
- `public/app/planner-scheduling.js`
  - Roept nu `setConfirmedRouteOrder()` aan na optimalisatie met `sourceOfTruth: "client_partitionedDay_optimization_pre_confirm"`.
  - Moet naar `setLocalDraftRouteOrder()` en logging met `sourceOfTruth: "local_route_draft"`.
- `public/app/planner-route.js`
  - Roept na `saveRouteTimes` nu `setConfirmedRouteOrder()` en `saveRouteOperationalLock()` aan.
  - Na centrale bevestiging mag de client hooguit serverresponse cachen; de bevestigde route blijft de Redis-lock die via reload/getAppointments terugkomt.
- `public/app/planner-actions.js`, `public/app/planner-manual-appointment.js`, `public/app/planner-scheduling.js`
  - Client-side guards moeten niet langer vertrouwen op lokale lock-state als centrale state bestaat.

### Migratiestrategie

- Implementatie leest tijdelijk beide namen:
  - Eerst `hk_route_local_draft_order_{dateStr}`.
  - Daarna legacy `hk_route_confirmed_order_{dateStr}`.
- Bij het lezen van legacy data:
  - Als er géén centrale locked Redis route is: kopieer legacy order naar `hk_route_local_draft_order_{dateStr}` en markeer als `local_route_draft`.
  - Als er wél een centrale locked Redis route is: negeer legacy localStorage volledig en verwijder of overschrijf de legacy key met de serverorder-cache.
- `routeOperationalLock` migreren:
  - Als centrale Redis-lock bestaat en `locked=true`: legacy `routeOperationalLock` negeren; server lock wint.
  - Als centrale lock ontbreekt of `locked=false`: legacy `routeOperationalLock.orderContactIds` converteren naar `routeLocalDraft`.
  - Na migratie `routeOperationalLock` niet meer terugschrijven.
- Geen bulk-migratie nodig. Dit is een lazy browser-migratie per dag bij `loadAppointments`.

## 2. Leesvolgorde voor route-state

Nieuwe leesvolgorde bij het laden van een dag:

1. `GET /api/ghl?action=getAppointments&date=...` haalt afspraken plus `routeLock` uit Redis op.
2. Als `routeLockStoreConfigured === true` en `routeLock.locked === true`:
   - Gebruik uitsluitend `routeLock.orderContactIds`, `routeLock.etasByContactId`, `routeLock.internalFixedStartByContactId`.
   - Negeer `hk_route_local_draft_order_*`, legacy `hk_route_confirmed_order_*`, `routeLocalDraft` en legacy `routeOperationalLock`.
   - Toon de route als centraal bevestigd.
3. Als `routeLockStoreConfigured === true` en er is geen locked route (`null`, missing of `locked=false`):
   - Gebruik lokale draft alleen als concept voor deze browser.
   - Toon duidelijk dat dit geen bevestigde route is.
   - Lokale draft wordt niet gemerged met oude centrale state.
4. Als Redis route-lock store niet geconfigureerd is:
   - Behoud bestaande lokale fallback alleen als degraded mode, met expliciete UI/logging dat multi-device consistentie niet gegarandeerd is.

Belangrijk: het is altijd óf centrale Redis route óf lokale draft. Geen merge tussen beide.

Files die dit moeten afdwingen:

- `api/ghl.js`
  - `getAppointments` blijft `routeLock` en `routeLockStoreConfigured` meesturen.
- `index.html`
  - `syncCentralRouteLockState()` mag bij missing central lock niet langer `lastKnownLockedOrderByDate` of lokale "confirmed" order als bevestigde route behandelen.
  - `applyRouteSnapshot()` moet `allowLooseSnapshot` alleen toestaan voor local draft mode, nooit wanneer een centrale locked route bestaat.
  - `getRouteStopsForSidebar()` moet dezelfde óf/óf-keuze volgen.
- `public/app/planner-route-snapshot.js`
  - `applyRouteSnapshot()` moet een expliciete mode krijgen: `serverConfirmed`, `localDraft`, of `disabled`.
- `public/app/planner-route-local-ui.js`
  - Hint moet lokale draft zichtbaar maken in plaats van verbergen zodra er een lokale lock-achtige payload bestaat.

## 3. Atomic compare-and-set voor route-lock writes

Huidige situatie:

- `lib/route-lock-store.js` leest de bestaande lock en schrijft daarna met `redis.set()`.
- `expectedRevision` wordt wel vergeleken, maar dit is read-then-write en dus niet atomisch.
- Twee gelijktijdige schrijfacties kunnen dezelfde revision lezen en daarna alsnog last-write-wins veroorzaken.

Voorstel:

- Vervang `setRouteLock()` intern door een atomaire Redis CAS via Lua script.
- Geen nieuwe dependency nodig; `@upstash/redis` ondersteunt Redis commands via de bestaande client.
- Lua script doet in één Redis-operatie:
  - `GET key`
  - parse bestaande `revision` uit JSON
  - vergelijk met `expectedRevision` als die is meegegeven
  - bij mismatch: return conflict + huidige lock
  - bij match: schrijf nieuwe JSON met `revision = currentRevision + 1`
- WATCH/MULTI/EXEC is minder geschikt voor Upstash REST/serverless; Lua is de voorkeur omdat het één roundtrip en één atomaire server-side operatie is.

Revision mismatch:

- `setRouteLock()` retourneert `{ ok: false, code: "REVISION_CONFLICT", currentLock }`.
- `api/ghl.js` retourneert `409 Conflict` met `code: "ROUTE_LOCK_REVISION_CONFLICT"` en `currentLock`.
- Client toont: "Route is door iemand anders aangepast, ververs om de nieuwste route te zien."
- Client doet daarna een stille `loadAppointments(..., { plannerLoadQuiet: true })` en verwerpt het lokale concept als `currentLock.locked === true`.

Geraakte files:

- `lib/route-lock-store.js`
- `api/ghl.js` bij `saveRouteTimes` en `setRouteLock`
- `public/app/planner-route.js` voor 409-afhandeling bij `confirmRoute`
- `index.html` voor 409-afhandeling bij `unlockRoute`

## 4. Server-side mutation guards

Doel: centrale route-lock moet ook server-side verhinderen dat route-impacting wijzigingen een bevestigde route onderuit halen.

Endpoints die moeten blokkeren als de betrokken datum centraal `locked=true` is:

- `POST /api/ghl?action=createAppointment`
  - Blokkeer als `date` locked is.
- `POST /api/ghl?action=rescheduleAppointment`
  - Blokkeer als `prevDate` locked is of `newDate` locked is.
- `POST /api/ghl?action=deletePlannerBooking`
  - Blokkeer als `routeDate` locked is.

Aanvullende route-impacting endpoints die in dezelfde guard moeten worden beoordeeld:

- `POST /api/ghl?action=setInternalFixedStart`
  - Dit beïnvloedt ETA/routeberekening en moet blokkeren als `routeDate` locked is.
- `POST /api/ghl?action=updatePlannerBookingDetails`
  - Alleen blokkeren als de wijziging route-impacting velden raakt.
  - Expliciet WEL blokkeren bij centrale `locked=true`:
    - `date`
    - `slotKey`
    - `slotLabel`
    - `type`
    - `address`
    - `internalFixedStart`
  - `address` is een bewust twijfelgeval: een typfoutcorrectie is een veelvoorkomende use case, maar adreswijziging beïnvloedt reistijd en routevolgorde. Voor sprint 1 blokkeren we daarom `address` met duidelijke UI-melding: "Adres wijzigen vereist eerst ontgrendelen."
  - Expliciet NIET blokkeren:
    - `price`
    - `priceLines` / productselectie
    - `plannerNotities` / notities
    - klantnaam
    - telefoon
    - e-mail
    - factuurvelden
    - statusvelden die geen routevolgorde, dagdeel, reistijd of ETA beïnvloeden

Force/admin override:

- Introduceer request body flag `forceRouteLockOverride: true`.
- Server accepteert deze alleen na bestaande planner-auth én een expliciete admin check.
- Als er nu nog geen harde admin-rol bestaat, sprint 1 implementeert de guard zonder publieke override en logt `FORCE_ROUTE_LOCK_OVERRIDE_UNAVAILABLE` wanneer de flag wordt meegestuurd.
- Als override later nodig is: audit log met `routeDate`, action, user, oldRevision, currentLock en payload-samenvatting.

Server helper:

- Voeg één helper toe in `api/ghl.js`, bijvoorbeeld `assertRouteMutationAllowed({ locationId, dateStr, action, forceRouteLockOverride, user })`.
- Return bij lock: `409 Conflict`, `code: "ROUTE_LOCKED_MUTATION_BLOCKED"`, `currentLock`.

## 5. UI-signalen

Visuele staten boven de route-lijst:

- Centrale bevestigde route:
  - Status: "Route bevestigd voor alle apparaten"
  - Badge: "Centraal bevestigd"
  - Kleur: bestaande centrale badge-stijl gebruiken of licht aanscherpen.
  - Drag/optimaliseer disabled; ontgrendel blijft zichtbaar.
- Lokale draft:
  - Status: "Lokaal concept - alleen zichtbaar op dit apparaat"
  - Badge: "Lokaal concept"
  - Route blijft bewerkbaar en kan met `Bevestig route` centraal worden opgeslagen.
  - Reset-knop blijft beschikbaar om het lokale concept te wissen.
- Geen draft en geen centrale route:
  - Status: "Nog niet bevestigd"
  - Geen badge of neutrale badge.
- Redis store niet beschikbaar:
  - Status: "Route-sync niet beschikbaar"
  - Badge: "Alleen lokaal"
  - Geen claim dat de route voor alle apparaten bevestigd is.

Als Jerry of planner een lokaal concept heeft en de ander bevestigt ondertussen centraal:

- Eerstvolgende polling/focus refresh ontvangt `routeLock.locked=true`.
- Client past centrale route toe en negeert/verwerpt lokale draft.
- Toast als `updatedBy` gevuld is: "De route is bijgewerkt door {updatedBy}. Jouw onbevestigde wijzigingen zijn vervallen."
- Toast als `updatedBy` leeg of onbekend is: "De route is centraal bijgewerkt. Jouw onbevestigde wijzigingen zijn vervallen."
- Debug log: `route_local_draft_discarded_due_to_server_lock` met date, localOrder, serverOrder, revision.

Geraakte files:

- `index.html`
  - `routePanelStatusText`, `routePanelStatusBadge`, `updateRoutePanelChrome()`.
- `public/app/planner-route-local-ui.js`
  - Tekst en zichtbaarheid van `routeLocalHint`.

### `updatedBy` huidige staat

- `updatedBy` bestaat nu al in de route-lock payload.
- Bij `Bevestig route` vult `public/app/planner-route.js` dit met `ctx.getCurrentPlannerUser()`; de context in `index.html` geeft daarvoor `readPlannerUsernameRaw() || ''` door.
- Bij ontgrendelen vult `index.html` `routeLock.updatedBy` met `readPlannerUsernameRaw() || 'unknown'`.
- `lib/route-lock-store.js` bewaart `updatedBy` als getrimde string of `null`.
- `readPlannerUsernameRaw()` leest de plannernaam uit `localStorage` key `hk_user`, die door de bestaande login-flow wordt gezet. Dit geeft in de praktijk namen zoals `daan` of `jerry`.
- Betrouwbaarheid: bruikbaar voor een operator-toast, maar niet als security/audit-identiteit. Het is browser/localStorage gebaseerd en kan leeg, verouderd of handmatig aangepast zijn.
- Sprint 1 gebruikt dit minimale bestaande mechanisme voor toasts. Als `updatedBy` ontbreekt of `unknown` is, valt de UI terug op de generieke toast "De route is centraal bijgewerkt. Jouw onbevestigde wijzigingen zijn vervallen."
- Geen volledige auth- of rollenrefactor in sprint 1.

## 6. Polling/refresh-gedrag

Huidig:

- Planner polling staat op 30 seconden via `PLANNER_AUTO_REFRESH_MS`.
- Focus/visibility refresh throttled op 10 seconden.

Voor sprint 1:

- Laat de basisinterval voorlopig 30 seconden om geen extra load te introduceren.
- Voeg route-revision detectie toe aan client state:
  - Bewaar per dag `lastSeenRouteRevision`.
  - Als `getAppointments` een hogere `routeLock.revision` teruggeeft, toon toast/log en forceer centrale route-state.
- Voeg een snelle follow-up refresh toe bij actieve centrale route:
  - Als de huidige dag een centrale `routeLock.locked === true` heeft en de client ziet dat de laatst bekende revision afwijkt van de lokale `lastSeenRouteRevision`, plan dan een stille refresh binnen 5 seconden.
  - Deze 5-seconden refresh is alleen voor een gedetecteerde route-revision wijziging of mismatch, niet als algemene pollingverlaging.
  - Basis polling blijft 30 seconden; focus/visibility refresh blijft zoals nu.
- Voeg eventueel later een lichte response header toe:
  - `X-HK-Route-Lock-Revision`
  - `X-HK-Route-Lock-Checksum`
  - Dit is handig maar niet vereist voor sprint 1, omdat `routeLock` al in de JSON response zit.
- Geen websocket/server push in deze sprint.

## 7. Rollback-strategie

- Voeg env var `ROUTE_REFACTOR_ENABLED` toe.
- Default gedrag: als de env var ontbreekt of niet exact `false` is, staat sprint 1 aan.
- Rollback: zet `ROUTE_REFACTOR_ENABLED=false` in Vercel.
- Verwacht effect bij `false`:
  - Nieuwe server-authoritative route-state afdwinging wordt uitgeschakeld.
  - Oude lokale fallback/override routegedrag blijft of wordt hersteld.
  - Atomic CAS en server mutation guards kunnen in disabled mode bypassed worden zodat bestaande workflows blijven werken zoals vóór sprint 1.
- Operationeel rollback-proces:
  - Vercel dashboard openen.
  - Project env var `ROUTE_REFACTOR_ENABLED` op `false` zetten voor Production.
  - Redeploy triggeren vanuit Vercel dashboard of de laatste Production deployment opnieuw deployen.
  - Geen codewijziging nodig voor de noodrem; Vercel moet wel een nieuwe serverless deployment/runtime met de aangepaste env var krijgen.
- Logging:
  - Bij disabled mode logt de server `ROUTE_REFACTOR_DISABLED` bij route-lock writes en route-impacting mutation guards.
  - Client mag `route_refactor_disabled` loggen als de server dit in responses teruggeeft.

## 8. Niet in deze sprint

- Auto-optimalisatie elke 15 minuten.
- Nieuwe-afspraak-trigger die route automatisch opnieuw inpast.
- Ochtendmeldingen met smaller venster.
- Onderweg-ETA via WhatsApp.
- Nieuw centraal draft-model in Redis.
- Grote UI-redesign of Tailwind/design-token werk.
- Refactor van het volledige `index.html` routeblok naar nieuwe componenten.

## 9. Testplan

Handmatige twee-device/twee-browser scenario's:

1. Centrale route wint van lokale draft:
   - Browser A maakt een lokale drag/drop draft, niet bevestigen.
   - Browser B bevestigt een andere route.
   - Browser A wacht op polling of gebruikt focus refresh.
   - Verwacht: A ziet route van B, lokale draft wordt genegeerd, toast verschijnt.
2. Lokale draft blijft lokaal zolang er geen centrale lock is:
   - Browser A optimaliseert route, niet bevestigen.
   - Browser B refreshes dezelfde dag.
   - Verwacht: B ziet geen lokale draft van A; alleen A ziet "Lokaal concept".
3. Bevestigde route is gelijk op beide apparaten:
   - Browser A bevestigt route.
   - Browser B refreshes.
   - Verwacht: zelfde volgorde, ETA's en centrale badge op beide browsers.
4. Atomic CAS conflict:
   - Browser A en B laden dezelfde revision.
   - Beide passen route aan.
   - A bevestigt eerst.
   - B bevestigt daarna zonder reload.
   - Verwacht: B krijgt 409, ziet conflict-toast, route reloadt naar A's centrale route.
5. Server mutation guard:
   - Bevestig route.
   - Probeer afspraak toe te voegen, te verplaatsen, te verwijderen en interne vaste start te wijzigen.
   - Verwacht: server retourneert 409 en UI toont unlock/ververs melding.
6. Unlock flow:
   - Bevestigde route ontgrendelen.
   - Verwacht: Redis lock revision gaat omhoog naar `locked=false`; beide browsers tonen "Nog niet bevestigd" of lokale draft indien aanwezig, maar geen centrale bevestiging.
7. Legacy localStorage migratie:
   - Zet handmatig legacy `hk_route_confirmed_order_YYYY-MM-DD` en `routeOperationalLock` in `hk_route_times_YYYY-MM-DD`.
   - Zonder centrale lock: legacy wordt lokale draft.
   - Met centrale lock: legacy wordt genegeerd.
8. `updatePlannerBookingDetails` guard:
   - Bevestig route.
   - Probeer `date`, `slotKey`, `slotLabel`, `type`, `address` en `internalFixedStart` te wijzigen.
   - Verwacht: server blokkeert met 409; UI toont voor adres expliciet "Adres wijzigen vereist eerst ontgrendelen."
   - Probeer prijs, productselectie, notities, klantnaam, telefoon, e-mail, factuurvelden en statusvelden zonder route-impact te wijzigen.
   - Verwacht: server staat dit toe.
9. Rollback flag:
   - Zet lokaal/test `ROUTE_REFACTOR_ENABLED=false`.
   - Verwacht: oude lokale fallback/override routegedrag is actief en server mutation guards blokkeren niet op centrale route-lock.

Technische checks:

- `npm test` blijft groen.
- Gerichte browserconsole logs:
  - `route_order_source`
  - `route_local_draft_loaded`
  - `route_local_draft_discarded_due_to_server_lock`
  - `route_lock_revision_conflict`
  - `route_locked_mutation_blocked`

