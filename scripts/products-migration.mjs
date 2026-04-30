import { Redis } from '@upstash/redis';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import { listPrices } from '../lib/prices-store.js';

const WRITE_MODE = process.argv.includes('--write');
const RESET_SEED = process.argv.includes('--seed-reset');

function redisPrefix() {
  return String(process.env.REDIS_KEY_PREFIX || 'prod:');
}

function pricesKey(locationId) {
  return `${redisPrefix()}hk:prices:${locationId}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRow(row = {}) {
  const id = String(row.id || '').trim() || `pr_mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const naam = String(row.naam || row.name || row.description || row.desc || '').trim();
  if (!naam) return null;
  const sku = String(row.sku || row.productnummer || '').trim() || null;
  const categorie = String(row.categorie || row.category || 'Serviceproducten').trim();
  const btwPct = Math.round(parseNum(row.btwPct ?? row.vatPct, 21) * 100) / 100;
  const incl = Math.round(Math.max(0, parseNum(row.verkoopprijsInclBtw ?? row.price ?? null, NaN)) * 100) / 100;
  const exclFromLegacy = parseNum(row.verkoopprijsExclBtw ?? row.priceExVat, NaN);
  const excl = Number.isFinite(incl) && incl > 0
    ? Math.round((incl / (1 + btwPct / 100)) * 100) / 100
    : (Number.isFinite(exclFromLegacy) ? Math.round(exclFromLegacy * 100) / 100 : 0);
  const inkoop = Math.round(Math.max(0, parseNum(row.inkoopprijs ?? row.costPrice, 0)) * 100) / 100;
  const marge = Math.round((incl - inkoop) * 100) / 100;

  return {
    id,
    sku,
    naam,
    categorie,
    inkoopprijs: inkoop,
    verkoopprijsInclBtw: incl,
    verkoopprijsExclBtw: excl,
    marge,
    btwPct,
    name: naam,
    description: naam,
    desc: naam,
    category: categorie,
    vatPct: btwPct,
    priceExVat: excl,
    price: incl,
    updatedAt: String(row.updatedAt || nowIso()),
  };
}

function equalForMigration(a, b) {
  return (
    String(a.id) === String(b.id) &&
    String(a.sku || '') === String(b.sku || '') &&
    String(a.naam || '') === String(b.naam || '') &&
    String(a.categorie || '') === String(b.categorie || '') &&
    Number(a.inkoopprijs || 0) === Number(b.inkoopprijs || 0) &&
    Number(a.verkoopprijsInclBtw || 0) === Number(b.verkoopprijsInclBtw || 0) &&
    Number(a.verkoopprijsExclBtw || 0) === Number(b.verkoopprijsExclBtw || 0) &&
    Number(a.marge || 0) === Number(b.marge || 0) &&
    Number(a.btwPct || 0) === Number(b.btwPct || 0)
  );
}

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL/TOKEN ontbreekt');
  return new Redis({ url, token });
}

async function main() {
  const locationId = ghlLocationIdFromEnv() || process.env.GHL_LOCATION_ID || 'default';
  const key = pricesKey(locationId);
  const redis = await getRedis();
  const raw = await redis.get(key);

  const inputRows = Array.isArray(raw)
    ? raw
    : (() => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(String(raw));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();

  const migratedRows = inputRows.map(normalizeRow).filter(Boolean);
  let changed = 0;
  for (let i = 0; i < migratedRows.length; i += 1) {
    if (!equalForMigration(inputRows[i] || {}, migratedRows[i] || {})) changed += 1;
  }

  console.log(`[products-migration] mode=${WRITE_MODE ? 'write' : 'dry-run'} location=${locationId}`);
  console.log(`[products-migration] key=${key}`);
  console.log(`[products-migration] input_rows=${inputRows.length} migratable=${migratedRows.length} to_change=${changed}`);
  if (migratedRows[0]) {
    console.log('[products-migration] sample_migrated=', JSON.stringify(migratedRows[0]));
  }

  if (!WRITE_MODE) {
    console.log('[products-migration] dry-run klaar. Gebruik --write om op te slaan.');
    return;
  }

  await redis.set(key, JSON.stringify(migratedRows));
  console.log(`[products-migration] wrote_migrated_rows=${migratedRows.length}`);

  if (RESET_SEED) {
    await redis.del(key);
    console.log('[products-migration] prices key deleted for seed reset');
    const seeded = await listPrices(locationId);
    console.log(`[products-migration] reseeded_rows=${seeded.length}`);
  }
}

main().catch((err) => {
  console.error('[products-migration] failed:', err?.message || err);
  process.exitCode = 1;
});
