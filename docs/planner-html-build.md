# Planner HTML: bron vs build (V2 / warm-minimal)

## Build

- Commando: `npm run build` → `node scripts/vercel-build-public.js`.
- Het script leest **elk `*.html` in de repository-root** en schrijft een kopie naar **`public/`** met dezelfde bestandsnaam.

## Welk bestand is de bron?

| Bestand | Rol |
|---------|-----|
| **`index.html`** (root) | **Canonieke bron** voor de planner-app (V2-layout: shell, inline `<style>`, panels, sidebar, scripts in `<head>`). Dit bestand hoort in git te staan en hier wijzig je de planner-markup en embedded planner-CSS. |

## Wat wordt gegenereerd / gekopieerd?

| Bestand | Rol |
|---------|-----|
| **`public/index.html`** | **Build-output** (lokaal en op Vercel): zelfde inhoud als root `index.html`, plus **cache-busting** (`?v=…`) op `href`/`src` naar o.a. `/styles/…`, `/app/…`, `manifest.webmanifest`, `icons/…`. |
| Andere root-`*.html` | Worden op dezelfde manier naar `public/*.html` gekopieerd. |

**Git:** `public/*.html` staat in **`.gitignore`**. De gegenereerde `public/index.html` hoort **niet** gecommit te worden; de bron blijft root-`index.html`.

## Logische overeenkomst na build

Na `npm run build` moeten root en `public/index.html` **inhoudelijk gelijk** zijn, afgezien van:

1. Querystring `?v=<buildVersion>` op genoemde asset-URLs (`buildVersion` = `VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, of tijdstempel lokaal).
2. Eventueel een `<meta name="hk-app-version" …>` direct na `<title>`, **alleen** als het build-script die nog niet in de HTML vindt (regex op `name="hk-app-version"` over het hele document).

Controle: regelcount gelijk (`wc -l index.html public/index.html`); `diff` toont alleen de `?v=`-regels (en eventueel meta).

## Waar pas je de V2 planner-layout aan?

1. **`index.html`** — **primaire plek**: layout-HTML (`.layout`, sidebar, panels), Warm-minimal / planner-CSS in `<style>`, volgorde van scripts.
2. **`public/styles/global.css`** — gedeelde tokens/componenten (Inter, `--bg-page`, `.hk-*`) voor consistentie met andere pagina’s; kleine planner-touches alleen als ze herbruikbaar moeten zijn.
3. **`public/app/planner-*.js`** — bij voorkeur **geen** pure layout-wijzigingen; alleen als strikt nodig voor CSS-hooks (classes) zonder gedrag te wijzigen.

Preview / Vercel gebruikt **`public/`** als output directory; lokaal na build altijd **`npm run build`** draaien (of `dev:vercel`) voordat je `public/index.html` test.
