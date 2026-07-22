/**
 * Eenmalige data-fix: corrigeer de categorie van producten die met een
 * niet-canonieke waarde (kleine letter/enkelvoud) in Redis staan, zodat ze
 * weer op de buslijst en in de voorraadtabel verschijnen.
 *
 * - Verifieert eerst de LIVE Redis-data (niet de catalog-v1.json snapshot).
 * - Schrijft via upsertPrice() (bestaand id → update), dus de normalisatie/
 *   validatie van prices-store blijft gerespecteerd. Geen directe Redis-write.
 * - Standaard DRY-RUN. Pas met --apply worden wijzigingen weggeschreven.
 *
 * Gebruik:
 *   set -a && source .env.local && set +a
 *   node scripts/fix-product-categories.mjs              # dry-run (toont plan)
 *   node scripts/fix-product-categories.mjs --apply      # schrijf de fix
 *   node scripts/fix-product-categories.mjs --only-visible# sla de 4 diensten over
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPricesStoreConfigured,
  listPrices,
  readRawPrices,
  upsertPrice,
} from '../lib/prices-store.js';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadEnvFromRepo() {
  for (const name of ['.env.local', '.env']) {
    const fp = path.join(root, name);
    if (!fs.existsSync(fp)) continue;
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
}

// Zichtbaarheids-kritieke producten (horen op buslijst/voorraad).
const VISIBLE_FIXES = [
  { id: 'pr_1780003820593_7twu26', naam: 'CUBE', categorie: 'Quookers' },
  { id: 'pr_1780057389402_yg8heq', naam: 'Fusion Round messing patina', categorie: 'Kranen' },
  { id: 'pr_1780002863621_7kmg3q', naam: 'Drukknop FLEX chroom', categorie: 'Serviceproducten' },
  { id: 'pr_1780002874797_wx6j5h', naam: 'Drukknop FLEX zwart', categorie: 'Serviceproducten' },
];

// Diensten: niet zichtbaar op buslijst/voorraad (bewust), maar wel rechtzetten
// voor consistentie. Overslaan met --only-visible.
const DIENSTEN_FIXES = [
  { id: 'pr_1780008158977_532djw', naam: 'Standaard onderhoud', categorie: 'Diensten' },
  { id: 'pr_1780008199881_fdd364', naam: 'Voorrijkosten', categorie: 'Diensten' },
  { id: 'pr_1780008238151_e8kta8', naam: 'Montage kosten', categorie: 'Diensten' },
  { id: 'pr_1780918048479_4gbwu6', naam: 'Monteur op locatie', categorie: 'Diensten' },
];

function rawCategoryOf(rawRow) {
  return String(rawRow?.categorie || rawRow?.category || '').trim() || '(leeg)';
}

async function main() {
  loadEnvFromRepo();

  const APPLY = process.argv.includes('--apply');
  const ONLY_VISIBLE = process.argv.includes('--only-visible');
  const targets = ONLY_VISIBLE ? VISIBLE_FIXES : [...VISIBLE_FIXES, ...DIENSTEN_FIXES];

  if (!isPricesStoreConfigured()) {
    console.error('❌ Prices store niet geconfigureerd: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ontbreken.');
    console.error('   Laad je env eerst, bijv.: set -a && source .env.local && set +a');
    process.exitCode = 1;
    return;
  }

  const locationId = ghlLocationIdFromEnv() || process.env.GHL_LOCATION_ID || 'default';
  console.log(`=== fix-product-categories (${APPLY ? 'APPLY' : 'DRY-RUN'}) — location=${locationId} ===\n`);

  // LIVE data ophalen: raw (echte opgeslagen waarde) + genormaliseerd (na code-fix).
  const [rawRows, normRows] = await Promise.all([readRawPrices(locationId), listPrices(locationId)]);
  const rawById = new Map(rawRows.map((r) => [String(r?.id || '').trim(), r]));
  const normById = new Map(normRows.map((r) => [String(r?.id || '').trim(), r]));

  const plan = [];
  for (const t of targets) {
    const raw = rawById.get(t.id);
    const norm = normById.get(t.id);
    if (!raw && !norm) {
      console.warn(`⚠️  ${t.id} (${t.naam}): NIET gevonden in live Redis — id gewijzigd of product verwijderd? Overslaan.`);
      continue;
    }
    const liveRaw = rawCategoryOf(raw);
    const nameLive = String(norm?.naam || norm?.name || raw?.naam || raw?.name || '').trim();
    const alreadyOk = liveRaw === t.categorie;
    console.log(
      `${alreadyOk ? '·' : '→'} ${t.naam} [${t.id}]\n` +
        `    live (raw) categorie: ${liveRaw}\n` +
        `    doel categorie:       ${t.categorie}` +
        (nameLive && nameLive.toLowerCase() !== t.naam.toLowerCase() ? `\n    ⚠️  naam in Redis wijkt af: "${nameLive}"` : '') +
        `\n`
    );
    if (!alreadyOk) plan.push({ target: t, norm });
  }

  if (!plan.length) {
    console.log('Niets te doen: alle doel-categorieën staan al goed in de live Redis-data.');
    return;
  }

  if (!APPLY) {
    console.log(`DRY-RUN: ${plan.length} product(en) zouden worden bijgewerkt. Draai met --apply om te schrijven.`);
    return;
  }

  let updated = 0;
  for (const { target, norm } of plan) {
    if (!norm) {
      console.warn(`⚠️  ${target.id} (${target.naam}): geen genormaliseerde bronrij om te upserten — overslaan.`);
      continue;
    }
    // Bestaande rij + gecorrigeerde categorie → update (zelfde id).
    const res = await upsertPrice(locationId, { ...norm, categorie: target.categorie });
    if (res?.ok) {
      updated += 1;
      console.log(`✓ bijgewerkt: ${target.naam} → ${res.row?.categorie}`);
    } else {
      console.error(`✗ mislukt: ${target.naam} (${target.id}) — ${res?.code || 'onbekend'}`);
    }
  }
  console.log(`\nKlaar: ${updated}/${plan.length} bijgewerkt.`);
  console.log('Vervolg: node scripts/export-catalog-v1-from-redis.js --dry-run  (controleer unmappedCategories)');
}

main().catch((err) => {
  console.error('[fix-product-categories] failed:', err?.message || err);
  process.exitCode = 1;
});
