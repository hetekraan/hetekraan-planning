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
  const description = String(row.description || '').trim();
  const category = String(row.category || 'Installatie').trim();
  const vatPct = Number(row.vatPct);
  const priceExVat = Number(row.priceExVat);
  if (!description || !Number.isFinite(vatPct) || !Number.isFinite(priceExVat)) return null;
  return {
    id,
    description,
    category,
    vatPct,
    priceExVat: Math.round(priceExVat * 100) / 100,
    sku: String(row.sku || '').trim() || null,
    updatedAt: String(row.updatedAt || nowIso()),
  };
}

const CSV_SEED_PATHS = [
  path.join(process.cwd(), 'data', 'prijzen_voor_dashboard.csv'),
  path.join(process.cwd(), 'data', 'prijzen_voor_dashboard2.csv'),
  path.join(process.cwd(), 'data', 'prijzen_voor_dashboard3.csv'),
];

const FALLBACK_PRICES = [
  { id: 'pr_fallback_001', description: 'Arbeid per uur', category: 'Arbeid & voorrijkosten', vatPct: 21, priceExVat: 89.0, sku: null },
  { id: 'pr_fallback_002', description: 'Voorrijkosten regio Amsterdam', category: 'Arbeid & voorrijkosten', vatPct: 21, priceExVat: 45.0, sku: null },
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

function categorizeSeedRow(description, sourcePath) {
  const name = String(description || '').toLowerCase();
  if (!name) return 'Installatie';
  if (name.includes('arbeid') || name.includes('voorrijkost')) return 'Arbeid & voorrijkosten';
  if (sourcePath.endsWith('prijzen_voor_dashboard.csv')) return 'Installatie';
  if (sourcePath.endsWith('prijzen_voor_dashboard3.csv')) return 'Reparatie';
  if (
    name.includes('filter') ||
    name.includes('co2') ||
    name.includes('serviceset') ||
    name.includes('service set') ||
    name.includes('appendage') ||
    name.includes('verlengset')
  ) {
    return 'Onderhoud';
  }
  return 'Installatie';
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
    const idxEx = headers.findIndex((h) => h.toLowerCase() === 'verkoopprijs ex btw');
    if (idxName < 0 || idxEx < 0) continue;
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(';');
      const description = String(cols[idxName] || '').trim();
      if (!description) continue;
      const priceExVat = parseEuroToNumber(cols[idxEx]);
      if (!Number.isFinite(priceExVat)) continue;
      const skuRaw = idxSku >= 0 ? String(cols[idxSku] || '').trim() : '';
      out.push({
        id: `pr_seed_${String(seq).padStart(4, '0')}`,
        description,
        category: categorizeSeedRow(description, sourcePath),
        vatPct: 21,
        priceExVat,
        sku: skuRaw || null,
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
