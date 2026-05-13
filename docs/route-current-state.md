# Huidige Routeplanning

Status: read-only inventarisatie voor de route-refactor. Dit document beschrijft de huidige werking zoals de code nu is, inclusief plekken waar de naamgeving "concept" en "bevestigd" door elkaar loopt.

## 1. Hoe werkt de huidige route-optimalisatie?

De planner heeft twee route-acties in de UI:

- `Optimaliseer route` in `index.html` regels 6861-6864 roept `optimizeRoute()` aan.
- `Bevestig route` in `index.html` regels 6861-6864 roept `confirmRoute()` aan.

Optimaliseren gebeurt client-gestuurd en handmatig. De client bouwt zelf de lijst met actieve stops en stuurt die naar `POST /api/optimize-route`. Er is geen automatische server-side heroptimalisatie na een nieuwe afspraak of na polling.

Client flow:

- `index.html` regels 12069-12072 dispatcht `optimizeRoute()` naar `window.HKPlannerScheduling.optimizeRoute`.
- `public/app/planner-scheduling.js` regels 7-25 blokkeert optimaliseren als de route al operationeel gelocked is en vereist minimaal 2 adressen.
- `public/app/planner-scheduling.js` regels 27-35 bouwt per afspraak de payload: `address`, `timeWindow`, `jobDuration`, `dayPart`, `bookingLocked`, `internalFixedStart`.
- `public/app/planner-scheduling.js` regels 54-62 stuurt `POST /api/optimize-route` met `mode: "partitionedDay"`, `returnToDepot: true` en de actieve afspraken.
- `public/app/planner-scheduling.js` regels 69-105 verwerkt `data.order` en `data.etas`, zet `timeSlot`, `estimated` en `violation` lokaal, en herschikt `appointments`.
- `public/app/planner-scheduling.js` regels 106-151 schrijft daarna lokale route-state (`hk_route_confirmed_order_*`, `lastPartitionedRoutePlanByDate`, `hk_route_times_*`) en rendert opnieuw. Dit is nog geen centrale server-save.

Server flow:

- `api/optimize-route.js` regels 1-10 beschrijven de twee modi: legacy batch en `partitionedDay`.
- `api/optimize-route.js` regels 797-815 accepteert alleen `POST`, leest `appointments`, `preserveOrder`, `origin`, `mode`, `returnToDepot`, en vereist `GOOGLE_MAPS_API_KEY`.
- `api/optimize-route.js` regels 613-794 behandelt `partitionedDay`: ochtendstops (`dayPart === 0`) worden gescheiden van middagstops; ochtend loopt 09:00-13:00, middag 13:00-17:00; de middag start vanaf het laatste ochtendadres of depot.
- `api/optimize-route.js` regels 228-240 gebruikt Google Distance Matrix om reistijden tussen depot/stops te berekenen.
- `api/optimize-route.js` regels 170-225 gebruikt een greedy scheduler op basis van reistijd en tijdvensters.
- `api/optimize-route.js` regels 90-167 berekent ETA's voor de gekozen volgorde, inclusief interne vaste starts (`internalFixedStart`).
- `api/optimize-route.js` regels 867-945 valt voor de legacy mode terug op Google Directions API met `optimize:true` als Distance Matrix niet gebruikt kan worden.

Parameters die nu meewegen:

- Adres: `fullAddressLine || address`.
- Tijdvenster: `timeWindow`, door `parseTimeWindow()` in `api/optimize-route.js` regels 43-67.
- Duur per afspraak: client `JOB_DURATION` in `index.html` regels 8020-8021 (`onderhoud` 45, `reparatie` 60, `installatie` 90); server valt terug op 30 minuten als input ontbreekt.
- Dagdeel: `dayPart` bepaalt ochtend/middag (`api/optimize-route.js` regels 619-624).
- Interne vaste start: `internalFixedStart` / `internalFixedStartTime`, met types `exact`, `after`, `before` (`api/optimize-route.js` regels 103-156 en `index.html` regels 8447-8549).
- Reistijd: Google Distance Matrix; fallback Directions API in legacy mode.

Onduidelijk / risicovol: `bookingLocked` wordt naar de route-API gestuurd (`public/app/planner-scheduling.js` regels 27-35), maar in de onderzochte route-API-code is geen duidelijke businessregel gevonden die `bookingLocked` apart laat meewegen.

## 2. Hoe werkt het opslaan van een route?

Er zijn drie lagen route-state:

1. Centrale route-lock in Redis via `lib/route-lock-store.js`.
2. Lokale route snapshot in `localStorage` via `hk_route_times_{dateStr}`.
3. Lokale "confirmed order" in `localStorage` via `hk_route_confirmed_order_{dateStr}`.

Redis keys:

- Centrale route-lock: `hk:route_lock:{locationId}:{dateStr}` in `lib/route-lock-store.js` regels 9-32.
- Model B reserveringen: `hk:block_res:uniq:{contactId}:{dateStr}`, `hk:block_res:data:{id}`, `hk:block_res:day:{dateStr}` in `lib/block-reservation-store.js` regels 26-45.
- Klantdag-vol vlag: `hk:customer_day_full:{locationId}:{dateStr}` in `lib/customer-day-full-store.js` regels 8-27.

Belangrijk: deze drie stores gebruiken vaste `hk:*` prefixes en geen `REDIS_KEY_PREFIX`.

Route opslaan:

- `public/app/planner-route.js` regels 68-89 selecteert actieve afspraken met `contactId`, `timeSlot` en status niet `klaar`.
- `public/app/planner-route.js` regels 78-85 bouwt `routeTimes`: `contactId`, `plannedTime`, `ghlAppointmentId`, `routeDate`, `startTime`, `durationMin`.
- `public/app/planner-route.js` regels 96-141 bouwt `routeLock`: `dateStr`, `locked: true`, `orderContactIds`, `etasByContactId`, `internalFixedStartByContactId`, `updatedBy`, `expectedRevision`.
- `public/app/planner-route.js` regels 125-143 stuurt `POST /api/ghl?action=saveRouteTimes`.
- `api/ghl.js` regels 3302-3355 schrijft de route-lock via `setRouteLock()`.
- `api/ghl.js` regels 3360-3396 schrijft per contact het GHL custom field geplande aankomst (`FIELD_IDS.geplande_aankomst`, hardcoded id `XELcOSdWq3tqRtpLE5x8`) en probeert de GHL kalenderafspraak start/eind bij te werken als er een `ghlAppointmentId` is.
- `api/ghl.js` regels 3398-3406 retourneert `routeLockSaved`, `routeLock`, `calendarSynced` en eventuele `calendarErrors`.

Verschil concept vs bevestigd:

- Er is geen helder afgescheiden server-side conceptmodel.
- Een optimalisatie of drag/drop schrijft direct lokale keys met namen als "confirmed", maar is nog niet centraal bevestigd.
- `public/app/planner-scheduling.js` regels 105-151 noemt de lokale optimalisatie `confirmedOrderIds` en schrijft `setConfirmedRouteOrder`, terwijl `sourceOfTruth` expliciet `client_partitionedDay_optimization_pre_confirm` is.
- `index.html` regels 10909-10915 doet hetzelfde na drag/drop.
- De echt centrale bevestiging is pas `saveRouteTimes` met `routeLock.locked === true`.

Endpoints die route-state schrijven:

- `POST /api/ghl?action=saveRouteTimes`: schrijft Redis route-lock, GHL geplande aankomst en eventueel GHL calendar start/end (`api/ghl.js` regels 3302-3406).
- `POST /api/ghl?action=setRouteLock`: schrijft/verwijdert centrale lock-state (`api/ghl.js` regels 3409-3463). De UI gebruikt dit voor unlock in `index.html` regels 10820-10849.
- `POST /api/ghl?action=createAppointment`: maakt Model B1 reservering in Redis (`api/ghl.js` regels 3742-3795), geen route-lock.
- `POST /api/ghl?action=rescheduleAppointment`: verplaatst Model B1 reservering (`api/ghl.js` regels 3963-4094), geen route-lock.
- `POST /api/ghl?action=deletePlannerBooking`: verwijdert Model B1 reservering (`api/ghl.js` regels 3868-3960), geen route-lock.

Concurrency:

- `lib/route-lock-store.js` regels 132-162 doet read-then-write met `expectedRevision`, maar niet atomisch. Twee gelijktijdige writes kunnen dezelfde revision lezen en daarna last-write-wins worden.

## 3. Hoe werkt handmatig slepen?

UI:

- Route-lijst staat in `index.html` regels 6848-6856 met tekst "Sleep om te herordenen".
- `renderRoute()` roept `initRouteDrag(list)` aan in `index.html` regels 10734-10740.
- Drag/drop zit in `index.html` regels 10851-10956.

Gedrag:

- `dragstart` blokkeert als `isRouteOperationalLockedForDate()` true is (`index.html` regels 10856-10866).
- `drop` blokkeert als de route gelocked is (`index.html` regels 10884-10890).
- Verplaatsen mag alleen binnen hetzelfde dagdeel (`index.html` regels 10894-10900).
- Na drop wordt de lokale `appointments`-volgorde aangepast (`index.html` regels 10902-10909).
- Daarna worden lokale route keys geschreven (`saveConfirmedRouteOrder`, `mergeRouteOrderIntoSnapshot`) in `index.html` regels 10909-10915.
- Daarna rekent de UI automatisch reistijden voor de nieuwe volgorde via `recalculateRouteTimesPreservingOrder(active)` (`index.html` regels 10922-10928).
- Als Maps/API faalt, valt de UI lokaal terug op geschatte 15 minuten tussen stops (`index.html` regels 10929-10951).

Server:

- Een handmatige verschuiving wordt niet direct naar de server gestuurd als centrale route-lock.
- De server krijgt de handmatige volgorde pas bij `Bevestig route` via `saveRouteTimes`.
- De tussentijdse ETA-berekening gebruikt wel `POST /api/optimize-route` met `preserveOrder: true` (`index.html` regels 10743-10763).

Vastgepinde / handmatig verplaatste afspraak:

- Er bestaat een concept van interne vaste start (`internalFixedPin` / `internalFixedStartTime`) met types `exact`, `after`, `before`.
- De UI slaat dit op via `setAppointmentInternalFixedStart()` naar `POST /api/ghl?action=setInternalFixedStart` (`index.html` regels 8447-8549).
- De route-API respecteert `internalFixedStart` bij ETA-berekening (`api/optimize-route.js` regels 103-156).
- Er is geen aparte persisted vlag "handmatig verplaatst"; handmatige volgorde leeft in lokale order/snapshot en later eventueel in centrale `routeLock.orderContactIds`.

## 4. Hoe werkt de afspraak-binnenkomst?

Er zijn meerdere bronnen voor afspraken in de planner:

- GHL calendar events, opgehaald door `GET /api/ghl?action=getAppointments`.
- Model B1 synthetische afspraken uit Redis block reservations.
- GHL blocked slots als block events.

Geen GHL appointment webhook gevonden voor de planner. De planner haalt data op via polling/fetch:

- `public/app/planner-load.js` regels 55-58 haalt `/api/ghl?action=getAppointments&date=...&_={Date.now()}` met `cache: 'no-store'`.
- `index.html` regels 10958-11077 doet automatische refresh elke 30 seconden, plus focus/visibility refresh, met guards voor modal, drag, save en prijs debounce.
- `api/ghl.js` regels 1235-1383 bouwt de planner response.
- `lib/planner-appointments-source.js` regels 75-120 haalt GHL calendar events voor de dag op.
- `lib/planner-appointments-source.js` regels 124-140 haalt blocked slots op.
- `lib/planner-appointments-source.js` regels 142-158 voegt Redis B1 synthetische afspraken toe als events met id `hk-b1:{contactId}:{date}`.
- `lib/planner-appointments-source.js` regels 160-183 haalt contactdetails op voor enrichment.

Nieuwe afspraken:

- Online klantboeking Model B1: `api/confirm-booking.js` regels 1-4 beschrijft dat token schema v2 geen timed GHL appointment maakt; de boeking wordt op contact custom fields en Redis vastgelegd.
- `api/confirm-booking.js` regels 707-1146 is de Model B1 confirm-flow; de response bevat `bookingModel: 'B'` en `appointmentId: null`.
- Handmatige plannerafspraak: `public/app/planner-manual-appointment.js` regels 548-580 stuurt `POST /api/ghl?action=createAppointment`.
- `api/ghl.js` regels 3466-3795 maakt/resolve't contact, schrijft contactvelden en maakt een Model B1 Redis reservering.

Wat doet route met nieuwe afspraken?

- Er is geen automatische centrale route-heroptimalisatie.
- Bij de volgende load komt de afspraak in `appointments`, daarna bepaalt `getRouteStopsForSidebar()` waar die verschijnt.
- Als er een server route-lock is, worden bekende contactIds geordend volgens `routeLock.orderContactIds`; nieuwe niet-genoemde afspraken worden daarna toegevoegd (`index.html` regels 8677-8702).
- Als er alleen lokale snapshots/confirmed order zijn, kan de nieuwe afspraak ook achter lokale volgorde geplakt worden (`index.html` regels 8704-8808).

Onduidelijk: er is geen eenduidige "nieuwe afspraak binnengekomen" eventbron. De live planner vertrouwt op polling/focus refresh, niet op push/websocket/webhook.

## 5. Hoe werken de ochtend- en onderweg-knoppen?

Ochtendmeldingen:

- Knop staat in `index.html` regel 6866: `Stuur ochtendmeldingen`.
- `index.html` regels 12057-12060 dispatcht naar `window.HKPlannerRoute.sendMorningMessages`.
- `public/app/planner-route.js` regels 42-57 selecteert afspraken met `contactId` en `status === 'ingepland'`, en stuurt `appointments: [{ contactId, timeFrom: timeSlot, timeTo: timeSlot }]` naar `POST /api/ghl?action=sendMorningMessages`.
- `api/ghl.js` regels 4097-4111 schrijft per contact `FIELD_IDS.geplande_aankomst` en pulst tag `ochtend-melding`.
- Response: `{ success: true, via: 'workflow-tag-ochtend-melding' }`.

Onderweg:

- Kaartknop wordt gerenderd in `index.html` regels 10123-10127 en 10235-10240.
- `askOnderweg()` opent de modal en toont de huidige ETA (`index.html` regels 11499-11509).
- `onderwegJaStuur()` vereist `contactId` en `timeSlot`, roept `sendETA(a)` aan en zet daarna lokaal `a.status = 'onderweg'` (`index.html` regels 11516-11559).
- `onderwegJeenBericht()` zet alleen lokaal `a.status = 'onderweg'`, zonder API-call (`index.html` regels 11561-11579).
- `sendETA()` dispatcht naar `window.HKPlannerRoute.sendETA` (`index.html` regels 12047-12055).
- `public/app/planner-route.js` regels 16-39 stuurt `POST /api/ghl?action=sendETA` met `contactId`, `eta`, `name`.
- `api/ghl.js` regels 3799-3835 schrijft geplande aankomst naar GHL en pulst workflow tag `process.env.GHL_ETA_WORKFLOW_TAG || 'monteur-eta'`.

Belangrijk: de status `onderweg` zelf lijkt client-lokaal te zijn. De API schrijft ETA/tag, maar geen centrale status `onderweg` die via `getAppointments` terugkomt.

## 6. Wat is de huidige state van de "Klaar"-knop bij een klant?

De knop bestaat:

- In touch price overlay: `index.html` regels 9712-9716.
- In appointment card/complete bar: `index.html` regels 10268-10272.
- Wrapper `confirmDone(id)` staat in `index.html` regels 12001-12028.
- De echte client-flow staat in `public/app/planner-actions.js` regels 75-381.

Client gedrag:

- Flushes eventuele prijsregels (`public/app/planner-actions.js` regels 108-113).
- Stuurt `POST /api/ghl?action=completeAppointment` met `contactId`, `appointmentId`, `type`, `sendReview`, `lastService`, `totalPrice`, `extras`, `basePrice`, `appointmentDesc`, `routeDate` (`public/app/planner-actions.js` regels 152-168).
- Als server ok is, zet de UI tijdelijk `a.status = 'klaar'`, rendert, en laadt daarna de server opnieuw (`public/app/planner-actions.js` regels 335-354).
- Als de server na reload geen `klaar` teruggeeft, wordt een waarschuwing getoond (`public/app/planner-actions.js` regels 355-368).

Server gedrag:

- `api/ghl.js` regels 1589-1665 bouwt en schrijft GHL custom fields voor complete-status.
- `lib/usecases/complete-appointment.js` regels 17-61 schrijft onder meer:
  - `datum_laatste_onderhoud` (`hiTe3Yi5TlxheJq4bLzy`)
  - legacy betalingsstatus `Afgerond` (`xAg0jUYsOL6IZZjdHuRq`)
  - bij installatie ook `datum_installatie`
  - legacy prijs en prijsregels
  - canonical `prijs_regels`, `prijs_totaal`, `betaal_status: Afgerond`
- `api/ghl.js` regels 1667-2383 probeert Moneybird facturatie aan te maken/versturen.
- `api/ghl.js` regels 2385-2400 voegt tag `factuur-versturen` toe en optioneel review tag via `ensureReviewMailTagOnComplete`.
- `lib/usecases/review-mail-tag.js` regels 1-20 definieert `REVIEW_MAIL_TAG = 'review_mail_versturen'` en vereist `sendReview === true` plus status `klaar`.
- `api/ghl.js` regels 2404-2407 zet opportunity stage naar `Uitgevoerd`.
- `api/ghl.js` regels 2409-2503 probeert inventory af te boeken.
- `api/ghl.js` regels 2505-2516 invalidatet dagcaches.
- Als Moneybird niet is afgehandeld, doet de client nog legacy Mollie fallback via `/api/create-payment` (`public/app/planner-actions.js` regels 313-333).

## 7. Reistijd-berekening

Route-optimalisatie en ETA's gebruiken Google APIs:

- `api/optimize-route.js` regels 228-240 gebruikt Google Distance Matrix.
- `api/optimize-route.js` regels 829-865 probeert Distance Matrix eerst.
- `api/optimize-route.js` regels 867-935 valt terug op Google Directions API in legacy mode.
- `index.html` regels 10743-10815 gebruikt dezelfde route-API met `preserveOrder: true` om na handmatig slepen ETA's voor de bestaande volgorde te berekenen.
- `index.html` regels 10929-10951 gebruikt lokale fallback: 15 minuten reistijd tussen stops als de route-API faalt.

Caching:

- Er is geen persistente cache voor route-optimalisatie-resultaten gevonden.
- `lastPartitionedRoutePlanByDate` in `index.html` regels 8188-8212 bewaart alleen runtime/UI-samenvatting in memory.
- `hk_route_times_{dateStr}` bewaart lokale ETA's/order in `localStorage` via `public/app/planner-route-snapshot.js` regels 94-132 en 193-202.
- Server-side dagdata heeft wel een process-local read cache van 45 seconden in `lib/amsterdam-day-read-cache.js` regels 12-43 en 94-102, maar dat is voor GHL events/blocked slots/Redis synthetics, niet voor Google routeberekeningen.

## 8. Welke locks/sloten bestaan er nu?

`routeOperationalLock`:

- Lokale lock in `localStorage` binnen `hk_route_times_{dateStr}`.
- Wordt genormaliseerd in `public/app/planner-route-snapshot.js` regels 47-69.
- Wordt opgeslagen via `saveRouteOperationalLock()` in `public/app/planner-route-snapshot.js` regels 141-203 na `Bevestig route` of na het laden van een server lock.
- Bevat `locked`, `savedAt`, `orderContactIds`, `etasByContactId`, optioneel `internalFixedStartByContactId`.
- Wordt gebruikt door `isRouteOperationalLockedForDate()` in `index.html` regels 8289-8293 om optimaliseren/slepen/mutaties te blokkeren.

`hk_route_confirmed_order_{dateStr}`:

- Lokale `localStorage` key, gedefinieerd in `index.html` regels 8135-8137.
- Wordt gelezen/geschreven/gewist in `index.html` regels 8139-8177.
- Wordt gezet na optimaliseren (`public/app/planner-scheduling.js` regels 105-110), na `Bevestig route` (`public/app/planner-route.js` regels 156-160), na het laden van server lock (`index.html` regels 8359-8360), en na drag/drop (`index.html` regels 10909-10915).
- Ondanks de naam is deze key niet altijd centraal bevestigd; optimaliseren en drag/drop zetten hem al pre-confirm.

Centrale Redis route-lock:

- Key: `hk:route_lock:{locationId}:{dateStr}` (`lib/route-lock-store.js` regels 9-32).
- Payload bij locked route bevat `locked`, `revision`, `orderChecksum`, `orderContactIds`, `etasByContactId`, optioneel `internalFixedStartByContactId`, `updatedAt`, `updatedBy` (`lib/route-lock-store.js` regels 74-110).
- Wordt gelezen bij `getAppointments` (`api/ghl.js` regels 1368-1383).
- Wordt geschreven bij `saveRouteTimes` en `setRouteLock` (`api/ghl.js` regels 3302-3463).
- Unlock stuurt `{ locked: false }` via `setRouteLock` (`index.html` regels 10820-10849).

Boekingssloten / B1 reserveringen:

- Key set: `hk:block_res:*` (`lib/block-reservation-store.js` regels 26-45).
- `createConfirmedReservation()` gebruikt `SET NX` op contact+dag om dubbele reservering voor dezelfde klant/dag te voorkomen (`lib/block-reservation-store.js` regels 135-177).
- `createAppointment`, `confirm-booking`, `rescheduleAppointment` en `deletePlannerBooking` gebruiken deze reserveringen voor de plannerfeed.

Dag-vol slot:

- Key: `hk:customer_day_full:{locationId}:{dateStr}` (`lib/customer-day-full-store.js` regels 8-27).
- Dit is geen route-lock, maar blokkeert klantboekingen voor die datum.

## Wat ontbreekt er voor de nieuwe features?

- Een eenduidig centraal conceptmodel voor route drafts. Nu bestaan lokale drafts, lokale "confirmed" orders en centrale locks naast elkaar.
- Server-authoritative route source-of-truth voor alle clients, ook bij unlocked/missing lock states.
- Atomaire compare-and-set voor route-lock writes; de huidige Redis write is read-then-set.
- Server-side route-mutation guards voor create/reschedule/delete/update als een route bevestigd is; nu is veel alleen client-side geblokkeerd.
- Een expliciete "onderweg" status in centrale data als die tussen apparaten zichtbaar moet zijn.
- Een event of versioning mechanisme voor route/planner data zodat clients weten dat ze stale zijn; polling bestaat, maar er is geen shared route-data version.
- Een duidelijke scheiding tussen "optimaliseer concept", "handmatig concept", "bevestigde route" en "ontgrendelde route".
- Mogelijk een server-side route recompute/reinsert flow voor nieuwe afspraken; nu gebeurt er niets automatisch met de route als er een afspraak bij komt.
