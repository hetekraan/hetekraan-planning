import { Redis } from '@upstash/redis';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'hk:prices';
let _redis = undefined;

function redisPrefix() {
  return String(process.env.REDIS_KEY_PREFIX || 'prod:');
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) _redis = new Redis({ url, token });
  return _redis;
}

export function isPricesStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function key(locationId) {
  return `${redisPrefix()}${PREFIX}:${String(locationId || 'default').trim() || 'default'}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePriceRow(row = {}) {
  const id = String(row.id || '').trim() || `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sku = String(row.sku || row.productnummer || '').trim() || null;
  const naam = String(row.naam || row.name || row.description || row.desc || '').trim();
  const categorie = String(row.categorie || row.category || 'Serviceproducten').trim();
  const vatPctRaw = Number(row.btwPct ?? row.vatPct ?? 21);
  const verkoopInclRaw = Number(row.verkoopprijsInclBtw ?? row.price ?? row.verkoopprijs_incl_btw ?? row.amount);
  const inkoopRaw = Number(row.inkoopprijs ?? row.costPrice ?? row.inkoopprijs_ex_btw ?? 0);
  if (!naam || !Number.isFinite(vatPctRaw) || !Number.isFinite(verkoopInclRaw) || !Number.isFinite(inkoopRaw)) return null;
  const btwPct = Math.max(0, Math.round(vatPctRaw * 100) / 100);
  const verkoopprijsInclBtw = Math.round(Math.max(0, verkoopInclRaw) * 100) / 100;
  const inkoopprijs = Math.round(Math.max(0, inkoopRaw) * 100) / 100;
  const factor = 1 + btwPct / 100;
  const verkoopprijsExclBtw = factor > 0 ? Math.round((verkoopprijsInclBtw / factor) * 100) / 100 : verkoopprijsInclBtw;
  const marge = Math.round((verkoopprijsInclBtw - inkoopprijs) * 100) / 100;
  const updatedAt = String(row.updatedAt || nowIso());
  return {
    id,
    sku,
    naam,
    categorie,
    inkoopprijs,
    verkoopprijsInclBtw,
    verkoopprijsExclBtw,
    marge,
    btwPct,
    // Backward compatibility for existing frontends.
    name: naam,
    description: naam,
    desc: naam,
    category: categorie,
    vatPct: btwPct,
    priceExVat: verkoopprijsExclBtw,
    price: verkoopprijsInclBtw,
    updatedAt,
  };
}

const CSV_SEED_PATHS = [
  path.join(process.cwd(), 'data', 'prijzen_voor_dashboard.csv'),
  path.join(process.cwd(), 'data', 'prijzen_voor_dashboard2.csv'),
  path.join(process.cwd(), 'data', 'prijzen_voor_dashboard3.csv'),
];

const FALLBACK_PRICES = [
  { id: 'pr_fallback_001', sku: 'FB.001', naam: 'Arbeid per uur', categorie: 'Serviceproducten', inkoopprijs: 55.0, verkoopprijsInclBtw: 89.0, btwPct: 21 },
  { id: 'pr_fallback_002', sku: 'FB.002', naam: 'Voorrijkosten regio Amsterdam', categorie: 'Serviceproducten', inkoopprijs: 25.0, verkoopprijsInclBtw: 45.0, btwPct: 21 },
];

function parseEuroToNumber(raw) {
  const s = String(raw || '')
    .replaceAll('€', '')
    .replaceAll(' ', '')
    .replaceAll('.', '')
    .replaceAll(',', '.')
    .trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function categoryFromSourcePath(sourcePath) {
  if (sourcePath.endsWith('prijzen_voor_dashboard.csv')) return 'Kranen';
  if (sourcePath.endsWith('prijzen_voor_dashboard2.csv')) return 'Quookers';
  return 'Serviceproducten';
}

async function buildSeedRowsFromCsvFiles() {
  const out = [];
  let seq = 1;
  for (const sourcePath of CSV_SEED_PATHS) {
    let content = '';
    try {
      content = await readFile(sourcePath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/).filter((x) => x.trim().length > 0);
    if (lines.length < 2) continue;
    const headers = lines[0].replace(/^\uFEFF/, '').split(';').map((x) => x.trim());
    const idxName = headers.findIndex((h) => h.toLowerCase() === 'productnaam');
    const idxSku = headers.findIndex((h) => h.toLowerCase() === 'productnummer');
    const idxInkoop = headers.findIndex((h) => h.toLowerCase().startsWith('inkoopprijs'));
    const idxIncl = headers.findIndex((h) => h.toLowerCase().includes('verkoopprijs in btw'));
    if (idxName < 0 || idxIncl < 0) continue;
    const categorie = categoryFromSourcePath(sourcePath);
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(';');
      const naam = String(cols[idxName] || '').trim();
      if (!naam) continue;
      const skuRaw = idxSku >= 0 ? String(cols[idxSku] || '').trim() : '';
      const inkoop = idxInkoop >= 0 ? parseEuroToNumber(cols[idxInkoop]) : 0;
      const verkoopIncl = parseEuroToNumber(cols[idxIncl]);
      if (!Number.isFinite(verkoopIncl)) continue;
      const safeSku = skuRaw || `NO_SKU_${i + 1}`;
      const id = `pr_seed_${String(seq).padStart(4, '0')}_${safeSku.replace(/[^a-zA-Z0-9]/g, '_')}`;
      out.push({
        id,
        sku: skuRaw || null,
        naam,
        categorie,
        inkoopprijs: Number.isFinite(inkoop) ? inkoop : 0,
        verkoopprijsInclBtw: verkoopIncl,
        btwPct: 21,
      });
      seq += 1;
    }
  }
  return out;
}

async function readRaw(locationId) {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.get(key(locationId));
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRaw(locationId, rows) {
  const redis = getRedis();
  if (!redis) return false;
  await redis.set(key(locationId), JSON.stringify(rows));
  return true;
}

export async function listPrices(locationId = 'default') {
  const rows = await readRaw(locationId);
  if (rows.length) return rows.map((x) => normalizePriceRow(x)).filter(Boolean);
  const csvSeed = await buildSeedRowsFromCsvFiles();
  const seedSource = csvSeed.length ? csvSeed : FALLBACK_PRICES;
  const seeded = seedSource.map((x) => normalizePriceRow(x)).filter(Boolean);
  await writeRaw(locationId, seeded);
  return seeded;
}

export async function upsertPrice(locationId = 'default', row = {}) {
  const normalized = normalizePriceRow(row);
  if (!normalized) return { ok: false, code: 'BAD_PAYLOAD' };
  const rows = await listPrices(locationId);
  const i = rows.findIndex((x) => x.id === normalized.id);
  if (i >= 0) rows[i] = { ...rows[i], ...normalized, updatedAt: nowIso() };
  else rows.push({ ...normalized, updatedAt: nowIso() });
  await writeRaw(locationId, rows);
  return { ok: true, row: i >= 0 ? rows[i] : normalized };
}

export async function deletePrice(locationId = 'default', id = '') {
  const target = String(id || '').trim();
  if (!target) return { ok: false, code: 'NO_ID' };
  const rows = await listPrices(locationId);
  const next = rows.filter((x) => x.id !== target);
  await writeRaw(locationId, next);
  return { ok: true };
}
