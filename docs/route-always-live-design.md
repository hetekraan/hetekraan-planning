# Route Always Live Design

Status: ontwerpdocument. Nog geen implementatie. Dit document vervangt de sprint-1 richting met `Bevestig route` / `Ontgrendel route`: de dagroute is altijd centraal, altijd live en wordt continu bijgewerkt via server-side writes.

## Doel en principes

- Iedere dag heeft exact een centrale route-state in Redis zodra de dag in de planner relevant wordt.
- Er is geen lokaal routeconcept en geen handmatige routebevestiging meer.
- Drag-and-drop schrijft direct naar de centrale route, met 1 seconde debounce.
- Auto-optimalisatie gebeurt alleen bij echte route-impacting events: nieuwe afspraak, verplaatsing, verwijdering, route-impacting edit en eerste page-load als de route achterloopt.
- Er komt geen cronjob die elke 15 minuten optimaliseert.
- Handmatig verslepen maakt een pin. De optimizer respecteert pins en bestaande `internalFixedStart` constraints.
- Afspraken met status `klaar` worden door de optimizer niet verplaatst of opnieuw ingepland.
- Alle andere statussen mogen door de planner versleept worden, inclusief `onderweg`.

## A. Datamodel

### Redis keys

Gebruik een nieuwe key-naam, omdat de route niet langer een lock is:

- `hk:route_live:{locationId}:{dateStr}`

Niet hergebruiken als primaire key: `hk:route_lock:{locationId}:{dateStr}`. De naam `lock` past niet meer bij het model en zou blijven suggereren dat een route eerst bevestigd/ontgrendeld moet worden. Wel kunnen we tijdens migratie tijdelijk uit `hk:route_lock:*` lezen als startpunt.

Voorgestelde payload:

```json
{
  "schemaVersion": 1,
  "dateStr": "2026-05-20",
  "revision": 12,
  "routeStatus": "live",
  "orderContactIds": ["c1", "c2"],
  "etasByContactId": { "c1": "09:00", "c2": "10:15" },
  "pinsByContactId": {
    "c2": {
      "type": "manual_order",
      "anchor": "after:c1",
      "createdAt": 1760000000000,
      "createdBy": "daan"
    }
  },
  "internalFixedStartByContactId": {
    "c1": { "type": "exact", "time": "09:00" }
  },
  "lastOptimizedAt": 1760000000000,
  "lastRouteInputChangedAt": 1760000000000,
  "optimizerVersion": "partitioned-day-v1",
  "updatedAt": 1760000000000,
  "updatedBy": "jerry",
  "source": "auto_optimize|manual_reorder|appointment_mutation|page_load"
}
```

`revision` blijft de concurrency primitive. Iedere write is CAS: client/server schrijft met `expectedRevision`; bij mismatch opnieuw lezen, opnieuw beslissen, en alleen nogmaals proberen als de intentie nog geldig is.

### Pins

Pins horen in de centrale route-state, niet als los veld op de afspraak zelf.

Redenen:

- Een pin is route-operationeel gedrag voor een specifieke dag, niet per se klant- of afspraakdata.
- Pins moeten in dezelfde atomic CAS-write meegaan als de routevolgorde.
- Pins kunnen verdwijnen wanneer de afspraak van de dag verdwijnt zonder GHL contact custom fields op te ruimen.

Pin-types:

- `manual_order`: ontstaan door drag-and-drop. De afspraak behoudt zijn relatieve plek in de dagroute zolang dit haalbaar is.
- `manual_eta` optioneel later: handmatig ingestelde ETA zonder GHL `internalFixedStart`. Niet in de eerste implementatiesprint.
- `internalFixedStart`: blijft de bestaande afspraakconstraint en wordt apart bewaard/gelezen zoals nu (`exact`, `after`, `before`). Deze heeft hogere prioriteit dan `manual_order`.

Pin ongedaan maken:

- UI toont op gepinde route-items een pin-indicator met actie "Pin losmaken".
- `POST /api/route/unpin` verwijdert `pinsByContactId[contactId]`, verhoogt `lastRouteInputChangedAt` en triggert daarna een server-side heroptimalisatie voor de dag.
- Als een afspraak wordt verwijderd of naar een andere dag verplaatst, verwijdert de server automatisch de pin voor die contactId uit de oude dagroute.

## B. Drag-and-drop flow

Flow:

1. Client sleept een niet-`klaar` afspraak in de routelijst.
2. UI past de volgorde optimistisch lokaal toe, toont "Route opslaan...".
3. Na 1 seconde debounce stuurt de client `POST /api/route/reorder`.
4. Payload bevat `dateStr`, `orderedContactIds`, `movedContactId`, `pin: true`, `expectedRevision`, `updatedBy`.
5. Server haalt actuele afspraken voor de dag op, filtert `klaar` uit route-mutaties, valideert dat alle contactIds nog op deze dag bestaan en schrijft de route atomic via CAS.
6. Server berekent ETA's opnieuw met `preserveOrder` voor gepinde volgorde plus optimizer voor niet-gepinde stops.
7. Response bevat de nieuwe route-state met `revision`.
8. Andere clients zien de wijziging via polling/focus refresh.

Polling:

- Basis blijft 30 seconden voor volledige plannerdata.
- Voor route-revision detectie mag een lichte 5 seconden follow-up worden gebruikt nadat een client een hogere route revision ziet of nadat een eigen write is gelukt.
- Geen websocket/server push in deze sprint.

Optimizer tegelijk met drag:

- Beide operaties schrijven dezelfde `hk:route_live:*` key met CAS.
- Als optimizer revision 10 leest en planner sleept naar revision 11, faalt de optimizer write met conflict.
- De optimizer leest revision 11 opnieuw, ziet de nieuwe pin, rekent opnieuw met die pin en schrijft revision 12.
- Als planner-write faalt omdat optimizer net won, haalt de client revision 11/12 op en probeert de reorder-intentie maximaal een keer opnieuw toe te passen op de nieuwste route. Als de afspraak intussen `klaar` of verdwenen is, stopt de retry met een nette melding.

## C. Auto-optimizer triggers

Server-side triggers:

- `createAppointment`: na succesvolle afspraak/reservering voor `date`.
- `rescheduleAppointment`: optimaliseer oude dag en nieuwe dag.
- `deletePlannerBooking`: optimaliseer de oude dag.
- `updatePlannerBookingDetails`: alleen bij route-impacting wijzigingen: `date`, `slotKey`, `slotLabel`, `type`, `address`, `internalFixedStart`.
- `completeAppointment`: markeert status `klaar`; daarna route voor die dag opnieuw evalueren zodat resterende stops opnieuw kunnen aansluiten zonder de klaargemaakte afspraak te bewegen.

Nieuwe endpoint-laag:

- `POST /api/route/reorder`: drag-and-drop + pin.
- `POST /api/route/unpin`: pin verwijderen.
- `POST /api/route/optimize`: expliciete server-side optimize voor een dag. Wordt intern aangeroepen door bovenstaande GHL endpoints en optioneel door page-load check.
- `GET /api/route?date=YYYY-MM-DD`: optioneel later als route-state los van `getAppointments` wordt gelezen. Voor de eerste implementatie kan `getAppointments` de route live-state blijven meesturen.

Page-load check:

- `getAppointments` retourneert route-state plus `routeInputFingerprint` of timestamps.
- Server bepaalt `lastRouteInputChangedAt` uit afspraakmutaties die route raken. Minimale eerste versie: bij iedere route-impacting endpoint-mutatie expliciet route-state markeren als dirty.
- Client hoeft niet zelf te raden of de route optimaal is. Bij load kan de server:
  - route-state missen: route initialiseren en optimaliseren;
  - route-state `lastOptimizedAt < lastRouteInputChangedAt`: optimalisatie starten;
  - optimizerVersion mismatch: optimalisatie starten;
  - alles actueel: route direct teruggeven.

Gedrag met pins en `internalFixedStart`:

- `internalFixedStart` wint van optimizer en van manual pins.
- `exact` betekent afspraak moet op die tijd starten.
- `after` betekent niet eerder dan die tijd.
- `before` betekent uiterlijk rond die tijd starten, rekening houdend met duur.
- `manual_order` pins behouden relatieve volgorde voor die contactIds.
- Niet-gepinde afspraken worden rondom pins geoptimaliseerd binnen dagdeel/tijdvenster.
- Als pins en fixed starts onmogelijk zijn, server retourneert route met `violationsByContactId` en verplaatst zo min mogelijk.

## D. Status-bescherming

Statusbron:

- De optimizer gebruikt dezelfde server-side appointment mapping als `getAppointments`.
- Een afspraak is `klaar` als de server-mapping status `klaar` is, gebaseerd op de bestaande canonical/GHL completionvelden.
- Client-local `hk_klaar_ids` telt niet als optimizer-bron.

Gedrag:

- `klaar` afspraken blijven zichtbaar als voltooid, maar worden uitgesloten uit nieuwe route-optimalisatie.
- Bestaande ETA/order voor `klaar` mag als historische weergave blijven staan, maar de optimizer schrijft geen nieuwe ETA voor die contactId.
- `onderweg`, `ingepland` en andere niet-klaar statussen blijven routeerbaar en versleepbaar.

Race: afspraak wordt net `klaar` terwijl optimizer wil schrijven:

1. Optimizer leest afspraken en route revision.
2. Voor de CAS-write doet de server een laatste status-check voor alle contactIds die hij wil wijzigen.
3. Als een afspraak inmiddels `klaar` is, verwijdert de server die uit de write-set en rekent opnieuw of markeert de optimize-run als stale.
4. De CAS-write bevat alleen niet-klaar stops en verhoogt revision.
5. Als `completeAppointment` zelf tegelijk een route dirty-mark schrijft, wint CAS en wordt de andere operatie herhaald op de nieuwste revision.

## E. UI-impact

Verwijderen:

- `Bevestig route` knop weg.
- `Ontgrendel route` knop weg.
- "Lokaal concept" UI weg.
- Reset naar lokale route-state weg of hernoemen naar "Heroptimaliseer route" als serveractie.

Nieuwe UI:

- Routepaneel toont live status:
  - "Live route"
  - "Geoptimaliseerd om 14:23"
  - "Bijwerken..." tijdens optimizer/reorder write
  - "Route bevat conflicten" als `violationsByContactId` bestaat
- Iedere route-item kan een pin-indicator tonen:
  - gepind door drag: pin-icoon + tooltip "Vastgezet door handmatige volgorde"
  - actie "Pin losmaken"
  - `internalFixedStart`: bestaande "Vast 09:00" pill blijft, maar labelt duidelijker `Exact`, `Na`, `Voor`
- Tijdens optimizer:
  - route-list krijgt subtiele loading state, maar blijft leesbaar;
  - drag/drop tijdelijk disabled voor dezelfde dag terwijl een eigen write in-flight is;
  - andere panelen blijven bruikbaar.
- Bij CAS conflict:
  - geen harde fout als retry slaagt;
  - bij definitieve fout: "Route is net bijgewerkt. Probeer je wijziging opnieuw."

## F. Sprint 1 hergebruik

Hergebruiken:

- Atomic CAS-concept uit `lib/route-lock-store.js`, maar hernoemd/verplaatst naar een route-live store (`lib/route-live-store.js`) met Lua CAS vanaf het begin.
- Tests voor first-write, conflict en expected revision semantiek.
- Server-side besef dat route-impacting mutaties centraal beoordeeld moeten worden, maar niet meer als "blokkeer als locked".
- Debug/logging rond route revision, checksum en updatedBy.
- Lazy opruiming van oude localStorage route keys, maar alleen om legacy state te verwijderen, niet om drafts te migreren.

Vereenvoudigen:

- Server mutation guards worden geen blokkade meer op route-lock. Route-impacting mutaties mogen door en triggeren daarna route-herberekening.
- Alleen status `klaar` is beschermd tegen optimizer/drag mutatie.

Droppen:

- `planner-route-mode.js` en de modes `serverConfirmed`, `localDraft`, `disabled`.
- `Bevestig route` en `Ontgrendel route`.
- Lokale draft/local route source-of-truth.
- Toast voor draft discard.
- `ROUTE_REFACTOR_ENABLED` als rollback naar lokale route-overrides. Als er een nieuwe feature flag komt, moet die hooguit auto-optimize uitschakelen, niet terugvallen naar client-partitioned routes.

## G. Migratiestrategie vanaf huidige productie

Huidige productie heeft:

- `hk:route_lock:{locationId}:{dateStr}` voor bevestigde route-locks.
- `hk_route_times_*` en `hk_route_confirmed_order_*` in browser localStorage.
- UI met `Bevestig route` en `Ontgrendel route`.

Migratie:

1. Deploy server met read-through migratie:
   - Bij eerste route-read voor een dag: lees `hk:route_live:*`.
   - Als die ontbreekt, lees bestaande `hk:route_lock:*`.
   - Als bestaande lock `locked=true` en order/ETA aanwezig is, schrijf een nieuwe `hk:route_live:*` met `source: "migrated_route_lock"` en revision 1.
   - Als bestaande lock ontbreekt of `locked=false`, initialiseer `hk:route_live:*` door actuele niet-klaar afspraken te optimaliseren.
2. Laat oude `hk:route_lock:*` ongemoeid voor rollback/observatie, maar schrijf er niet meer naar.
3. Client negeert lokale route localStorage volledig voor routevolgorde.
4. Client verwijdert legacy route localStorage keys opportunistisch na succesvolle load.
5. UI-release verwijdert confirm/unlock knoppen pas nadat server route-live read/write werkt.
6. Geen downtime: bij ontbrekende live route kan server synchronisch initialiseren of een korte loading state teruggeven terwijl optimize start.

Rollback:

- Rollback is deploy rollback naar vorige versie, niet feature flag naar localStorage-route.
- Omdat oude `hk:route_lock:*` niet direct wordt verwijderd, vorige productie kan nog lezen wat hij kende.
- Nieuwe writes naar `hk:route_live:*` worden dan tijdelijk genegeerd door oude productie.

## H. Onderweg-flow

Doel:

- Jerry zet klant `klaar`.
- Factuurflow blijft lopen via bestaande `completeAppointment`.
- Daarna vraagt de UI: "Onderweg naar [volgende klant]?"
- Bij bevestiging: WhatsApp ETA wordt klaargezet/verstuurd, met 30 seconden annuleerbuffer.

Flow:

1. `completeAppointment` rondt huidige klant af en triggert route-heroptimalisatie voor resterende niet-klaar stops.
2. Server bepaalt op basis van de live route de volgende niet-klaar stop.
3. Client toont prompt met naam, adres en ETA: "Onderweg naar De Vries om ~10:45?"
4. Bij ja: `POST /api/route/send-next-eta` met `currentContactId`, `nextContactId`, `routeDate`, `eta`, `revision`.
5. Server schrijft een pending ETA-send record in Redis met TTL/executeAt + 30 seconden.
6. UI toont "WhatsApp wordt over 30 sec verstuurd" met annuleren.
7. Na 30 seconden voert server of een request-driven worker de bestaande ETA workflow uit:
   - GHL custom field geplande aankomst = ETA.
   - Tag/workflow: bestaande `monteur-eta` (`GHL_ETA_WORKFLOW_TAG`) of nieuwe expliciet benoemde workflowtag.

Open punt:

- Serverless zonder cron/queue heeft geen gegarandeerde background timer. Eerste implementatie kan de 30 sec buffer client-driven doen zolang de app open is; robuuste productievariant vraagt een queue/cron/Upstash QStash. Dit niet stilzwijgend als betrouwbaar background-systeem ontwerpen.

## I. Ochtendmelding

Nieuw gedrag:

- Venster wordt smaller: 1 uur rondom ETA.
- Eerste klant in route krijgt exacte starttijd 09:00, tenzij een `internalFixedStart exact` iets anders afdwingt.
- Voor iedere niet-klaar afspraak met ETA:
  - `timeFrom = ETA - 30 min`
  - `timeTo = ETA + 30 min`
  - afronden op nette kwartieren waar nodig.

Trigger:

- Eerste versie: handmatig via bestaande "Stuur ochtendmeldingen" knop, maar payload gebruikt live route ETA's en smaller venster.
- Automatisch vast tijdstip is niet in de eerste implementatiesprint, tenzij apart besloten. Als dit later komt: server-side scheduled job, niet client timer.

GHL:

- Hergebruik bestaande `sendMorningMessages` endpoint/tag `ochtend-melding`.
- Pas data aan van `timeFrom: timeSlot, timeTo: timeSlot` naar het 1-uursvenster.
- Log per contact ETA, venster, route revision en workflow tag.

## J. Testplan

Handmatig voor merge:

1. Eerste page-load zonder route-live key:
   - Open dag met meerdere afspraken.
   - Verwacht: server maakt centrale live route; beide browsers zien dezelfde volgorde.
2. Twee browsers:
   - Browser A sleept afspraak.
   - Binnen debounce schrijft server.
   - Browser B ziet route via refresh/polling zonder lokale state.
3. Optimizer tijdens drag:
   - Trigger afspraakmutatie terwijl Browser A sleept.
   - Verwacht: CAS conflict wordt herlezen; pin blijft behouden.
4. Nieuwe afspraak:
   - Maak afspraak op dag met bestaande route.
   - Verwacht: nieuwe stop wordt centraal ingepast zonder confirm-knop.
5. Verplaatsing:
   - Verplaats afspraak van dag A naar dag B.
   - Verwacht: beide dagen worden opnieuw consistent.
6. Verwijdering:
   - Verwijder gepinde afspraak.
   - Verwacht: pin verdwijnt en route blijft geldig.
7. Klaar race:
   - Zet afspraak klaar terwijl optimizer draait.
   - Verwacht: afspraak wordt niet verplaatst; resterende route wordt opnieuw berekend.
8. Onderweg mag slepen:
   - Zet afspraak lokaal/centraal op onderweg.
   - Versleep hem.
   - Verwacht: toegestaan zolang status niet `klaar` is.
9. Pins:
   - Sleep afspraak, refresh beide browsers.
   - Verwacht: pin zichtbaar op beide.
   - Pin losmaken triggert heroptimalisatie.
10. `internalFixedStart`:
   - Exact/after/before instellen.
   - Verwacht: optimizer respecteert constraint en toont violation als onmogelijk.
11. Ochtendmelding:
   - Verstuur ochtendmeldingen.
   - Verwacht: eerste klant 09:00, overige klanten 1-uursvenster rondom ETA.
12. Onderweg-next prompt:
   - Klaar afronden.
   - Verwacht: prompt voor volgende klant, ETA-send met 30 sec annuleren.
13. Legacy migration:
   - Dag met bestaande `hk:route_lock:*`.
   - Verwacht: eerste load migreert naar `hk:route_live:*`.
14. LocalStorage cleanup:
   - Browser met oude `hk_route_times_*` en `hk_route_confirmed_order_*`.
   - Verwacht: routeweergave gebruikt server; oude keys worden verwijderd of genegeerd.

Technische tests:

- Unit tests voor route-live CAS.
- Unit tests voor pin-normalisatie en pin-verwijdering.
- Unit tests voor optimizer inputfilter: `klaar` uitgesloten, `onderweg` inbegrepen.
- Endpoint tests voor create/reschedule/delete/update triggering route dirty/optimize.
- Conflict tests: reorder vs optimize, complete vs optimize.

## K. Expliciet niet in deze sprint

- Geen cronjob elke 15 minuten.
- Geen websocket/live push.
- Geen volledige UI-redesign of Tailwind-conversie.
- Geen nieuw auth/rollenmodel voor `updatedBy`.
- Geen complexe multi-day routeoptimalisatie.
- Geen monteurscapaciteit of meerdere voertuigen.
- Geen betaal/factuurflow refactor.
- Geen GHL workflow-herbouw; alleen bestaande tags/workflows aanroepen met betere data.
- Geen gegarandeerde server-side 30-sec ETA queue tenzij expliciet gekozen als aparte infrastructuurtaak.
- Geen Supabase-migratie van route-state.
- Geen behoud van lokale route-drafts als fallback source-of-truth.
- Geen support voor "bevestigde route" als aparte status: de route is live of niet beschikbaar.
