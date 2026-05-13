# Sprint 1 Preview Findings

## Probleem 1 - `expectedRevision=0` terwijl Redis revision hoger is

De save-flow roept `getRouteLockRevisionForDate(dateStr)` wel aan voor de write. In `public/app/planner-route.js:157-161` wordt de huidige revision opgehaald en daarna meegestuurd in de `saveRouteTimes` payload (`public/app/planner-route.js:136-151`). De waarde `0` komt dus niet doordat de functie niet wordt aangeroepen, maar doordat de client-state waaruit die functie leest leeg is.

De revision-bron staat in `index.html:8442-8449`: eerst `lastSeenRouteRevisionByDate`, daarna `serverRouteLockByDate`, anders `0`. `getAppointments` levert de lock wel mee (`api/ghl.js:1511-1526`) en de client roept daarna `syncCentralRouteLock(dateStr, data.routeLock, ...)` aan (`public/app/planner-load.js:113-118`). Bij `ROUTE_REFACTOR_ENABLED=true` hoort `syncCentralRouteLockState()` via `handleRouteModeTransition()` de revision in `lastSeenRouteRevisionByDate` te zetten (`index.html:8578-8616`), en bij een locked serverroute wordt de lock ook in `serverRouteLockByDate` gezet (`index.html:8690-8705`).

De preview-log past vooral bij de disabled/rollback-route: `syncCentralRouteLockState()` bepaalt dan mode `disabled` en returnt vroeg (`index.html:8646-8661`). In die tak wordt `serverRouteLockByDate` zelfs verwijderd en wordt `handleRouteModeTransition()` niet aangeroepen. Daardoor wordt een bestaande Redis revision, bijvoorbeeld 4, niet in `lastSeenRouteRevisionByDate` opgeslagen. `confirmRoute()` leest vervolgens `0` en stuurt `expectedRevision=0`.

Er is daarnaast een kleinere race mogelijk: er is geen guard die `confirmRoute()` blokkeert als de eerste `getAppointments` response nog niet verwerkt is. Als de gebruiker bevestigt voordat `syncCentralRouteLockState()` de revision heeft gevuld, valt `getRouteLockRevisionForDate()` ook terug naar `0`.

De retry-logica triggert wel op 409: `public/app/planner-route.js:162-175` herlaadt stil en probeert eenmaal opnieuw. Maar als de feature flag uit staat, vult die stille refresh de revision opnieuw niet door de vroege `disabled` return hierboven. Dan blijft de retry dezelfde verkeerde revision gebruiken.

## Probleem 2 - feature flag rollback-semantiek

De geïmplementeerde optie is nu (b): geen atomic Lua-CAS, maar nog wel revision-semantiek. `lib/route-lock-store.js:292-305` schakelt bij `ROUTE_REFACTOR_ENABLED=false` naar `setRouteLockLegacyReadThenWrite()`, maar die legacy functie vereist nog steeds `expectedRevision` bij een bestaande lock en geeft `REVISION_CONFLICT` bij mismatch (`lib/route-lock-store.js:203-221`).

De bedoelde optie volgens het plan was (a): volledige noodrem naar pre-refactor gedrag. Het plan zegt expliciet dat `ROUTE_REFACTOR_ENABLED=false` het oude lokale fallback/override gedrag moet herstellen en dat atomic CAS en server mutation guards in disabled mode gebypassed kunnen worden zodat workflows blijven werken zoals vóór sprint 1 (`docs/route-refactor-sprint-1-plan.md:244-250`). De huidige implementatie is dus geen volledige rollback.

## Voorstel

1. Maak `ROUTE_REFACTOR_ENABLED=false` echt pre-refactor voor route-lock writes: in de legacy disabled path geen `expectedRevision` verplichten en geen mismatch blokkeren. Dat is bewust last-write-wins en alleen voor de noodrem.
2. Vul de revision-cache onafhankelijk van de UI mode zodra `getAppointments` een `routeLock.revision` teruggeeft. Ook in `disabled` mode moet de client de revision kennen zolang de server nog revision-checks kan doen.
3. Voeg een extra fallback toe in de retry: gebruik `currentLock.revision` uit de 409 response direct als nieuwe `expectedRevision`, in plaats van alleen te vertrouwen op een refresh die client-state bijwerkt.
4. Voeg een load-inflight guard of disabled state toe rond `Bevestig route` totdat de eerste `getAppointments` sync voor de actieve dag klaar is.
