import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import { isPricesStoreConfigured, listPrices } from '../lib/prices-store.js';

/**
 * Genereer public/data/catalog-v1.json vanuit de live Redis-prijzen (planner Producten-UI),
 * zodat het klant-boekingsformulier (suggest.html) dezelfde prijzen gebruikt als de planner.
 *
 * Gebruik:
 *   set -a && source .env.local && set +a
 *   node scripts/export-catalog-v1-from-redis.js --dry-run   # toon diff, schrijf niet
 *   node scripts/export-catalog-v1-from-redis.js             # schrijf catalog-v1.json
 */

const DRY_RUN = process.argv.includes('--dry-run');
const OUTPUT_JSON = path.resolve(process.cwd(), 'public/data/catalog-v1.json');

/** Redis-categorie (lowercased) → catalog-v1 categorie. Onbekend = overnemen (niet droppen). */
const CATEGORY_MAP = {
  kranen: 'kraan',
  quookers: 'quooker',
  serviceproducten: 'service',
  diensten: 'diensten',
};

const unmappedCategories = new Set();

function mapCategory(rawCategorie) {
  const raw = String(rawCategorie || '').trim();
  if (!raw) return 'overig';
  const mapped = CATEGORY_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  unmappedCategories.add(raw);
  return raw;
}

function slugId(category, name, sku) {
  const base = `${category}-${name}${sku ? `-${sku}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base || 'item';
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function redisRowToCatalogItem(row = {}) {
  const name = String(row.naam || row.name || row.description || row.desc || '').trim();
  const price = round2(row.verkoopprijsInclBtw ?? row.price);
  const rawCategorie = String(row.categorie || row.category || '').trim();
  const category = mapCategory(rawCategorie);
  const sku = String(row.sku || '').trim();
  if (!name || !Number.isFinite(price) || price < 0) return null;
  const searchText = `${name} ${category}${sku ? ` ${sku}` : ''} ${rawCategorie}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return {
    id: String(row.id || '').trim() || slugId(category, name, sku),
    category,
    name,
    price,
    sourceSheet: rawCategorie || 'Redis',
    aliases: [name.toLowerCase(), category],
    searchText,
    active: row.active !== false,
  };
}

/** Diff-sleutel: producten worden herkend op categorie + genormaliseerde naam (IDs verschillen tussen bronnen). */
function diffKey(item) {
  return `${String(item.category || '').toLowerCase()}||${String(item.name || '').toLowerCase().trim()}`;
}

function readCurrentCatalog() {
  try {
    const raw = fs.readFileSync(OUTPUT_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return { exists: true, items };
  } catch {
    return { exists: false, items: [] };
  }
}

function euro(n) {
  return `€${Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computeDiff(currentItems, nextItems) {
  const curMap = new Map(currentItems.map((x) => [diffKey(x), x]));
  const nextMap = new Map(nextItems.map((x) => [diffKey(x), x]));

  const priceChanges = [];
  const added = [];
  const removed = [];

  for (const [key, next] of nextMap) {
    const cur = curMap.get(key);
    if (!cur) {
      added.push(next);
      continue;
    }
    const curPrice = round2(cur.price);
    const nextPrice = round2(next.price);
    if (curPrice !== nextPrice) {
      priceChanges.push({ item: next, from: curPrice, to: nextPrice });
    }
  }
  for (const [key, cur] of curMap) {
    if (!nextMap.has(key)) removed.push(cur);
  }
  return { priceChanges, added, removed };
}

function printDiff(current, nextItems) {
  const { priceChanges, added, removed } = computeDiff(current.items, nextItems);

  console.log('');
  console.log('=== catalog-v1 export — DRY RUN (geen bestand geschreven) ===');
  console.log(`bron:    Redis (${nextItems.length} items)`);
  console.log(`huidig:  ${OUTPUT_JSON} (${current.exists ? current.items.length : 0} items${current.exists ? '' : ' — bestaat nog niet'})`);
  console.log('');

  if (priceChanges.length) {
    console.log(`── Prijswijzigingen (${priceChanges.length}) ──`);
    for (const c of priceChanges.sort((a, b) => a.item.category.localeCompare(b.item.category) || a.item.name.localeCompare(b.item.name))) {
      console.log(`  [${c.item.category}] ${c.item.name}: ${euro(c.from)} → ${euro(c.to)}`);
    }
    console.log('');
  } else {
    console.log('── Geen prijswijzigingen ──');
    console.log('');
  }

  if (added.length) {
    console.log(`── Nieuwe producten (${added.length}) ──`);
    for (const a of added) console.log(`  + [${a.category}] ${a.name} — ${euro(a.price)}`);
    console.log('');
  }

  if (removed.length) {
    console.log(`── Verdwijnen uit catalogus (${removed.length}) ──`);
    for (const r of removed) console.log(`  - [${r.category}] ${r.name} — ${euro(r.price)}`);
    console.log('');
  }

  if (!priceChanges.length && !added.length && !removed.length) {
    console.log('Geen verschillen: catalog-v1.json is al in sync met Redis.');
    console.log('');
  }
}

function printValidationWarnings(current, nextItems) {
  let hasWarning = false;

  if (unmappedCategories.size) {
    hasWarning = true;
    console.warn(`⚠️  Onbekende categorie(ën) overgenomen (niet gedropt): ${[...unmappedCategories].join(', ')}`);
    console.warn('    Voeg deze toe aan CATEGORY_MAP als suggest.html een specifieke categorie verwacht.');
  }

  if (current.exists && nextItems.length < current.items.length) {
    hasWarning = true;
    console.warn(
      `⚠️  Export bevat MINDER items (${nextItems.length}) dan de huidige catalog-v1.json (${current.items.length}).`
    );
    console.warn('    Dit duidt meestal op een probleem (mapping-fout / lege Redis), niet op bewust verwijderen.');
    console.warn('    Controleer de "Verdwijnen uit catalogus"-lijst hierboven voordat je schrijft.');
  }

  if (!nextItems.length) {
    hasWarning = true;
    console.warn('⚠️  Export bevat 0 items — controleer of Redis gevuld is en env-variabelen kloppen.');
  }

  if (hasWarning) console.warn('');
  return hasWarning;
}

async function main() {
  if (!isPricesStoreConfigured()) {
    console.error('❌ Prices store niet geconfigureerd: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ontbreken.');
    console.error('   Laad je env eerst, bijv.: set -a && source .env.local && set +a');
    process.exitCode = 1;
    return;
  }

  const locationId = ghlLocationIdFromEnv() || process.env.GHL_LOCATION_ID || 'default';
  const rows = await listPrices(locationId);
  const nextItems = rows.map(redisRowToCatalogItem).filter(Boolean);

  const current = readCurrentCatalog();

  if (DRY_RUN) {
    printDiff(current, nextItems);
    printValidationWarnings(current, nextItems);
    console.log(`Dry-run klaar (location=${locationId}). Draai zonder --dry-run om te schrijven.`);
    return;
  }

  const hadWarning = printValidationWarnings(current, nextItems);
  if (hadWarning && nextItems.length === 0) {
    console.error('❌ Niet geschreven: export is leeg. Draai --dry-run en controleer de configuratie.');
    process.exitCode = 1;
    return;
  }

  const payload = {
    version: 1,
    source: 'redis',
    sourceLocationId: locationId,
    generatedAt: new Date().toISOString(),
    itemCount: nextItems.length,
    items: nextItems,
  };
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`catalog-v1 geschreven vanuit Redis: ${OUTPUT_JSON} (${nextItems.length} items, location=${locationId})`);
}

main().catch((err) => {
  console.error('[export-catalog-v1-from-redis] failed:', err?.message || err);
  process.exitCode = 1;
});
