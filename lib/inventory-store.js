import { Redis } from '@upstash/redis';

const PREFIX = 'hk:inventory';
let _redis = undefined;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (_redis === undefined) _redis = new Redis({ url, token });
  return _redis;
}

export function isInventoryStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function key(locationId) {
  return `${PREFIX}:${String(locationId || 'default').trim() || 'default'}`;
}

function normalizeItem(row = {}) {
  const id = String(row.id || '').trim() || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const name = String(row.name || '').trim();
  const category = String(row.category || 'Overig').trim();
  const stock = Number(row.stock);
  const minStock = Number(row.minStock);
  const costPrice = Number(row.costPrice);
  if (!name || !Number.isFinite(stock) || !Number.isFinite(minStock) || !Number.isFinite(costPrice)) return null;
  return {
    id,
    name,
    category,
    stock: Math.max(0, Math.floor(stock)),
    minStock: Math.max(0, Math.floor(minStock)),
    costPrice: Math.round(costPrice * 100) / 100,
    updatedAt: new Date().toISOString(),
  };
}

const DEFAULT_ITEMS = [
  { name: 'CUBE filter cartridge', category: 'Filters', stock: 18, minStock: 6, costPrice: 42.98 },
  { name: 'Set van 4 CO2 flessen', category: 'CO2', stock: 7, minStock: 4, costPrice: 35.78 },
  { name: 'Mengventiel', category: 'Onderdelen', stock: 2, minStock: 5, costPrice: 45.66 },
  { name: 'Perlatorhuls FX', category: 'Onderdelen', stock: 0, minStock: 8, costPrice: 2.69 },
];

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

export async function listInventory(locationId = 'default') {
  const rows = await readRaw(locationId);
  if (rows.length) return rows.map((x) => normalizeItem(x)).filter(Boolean);
  const seeded = DEFAULT_ITEMS.map((x) => normalizeItem(x)).filter(Boolean);
  await writeRaw(locationId, seeded);
  return seeded;
}

export async function upsertInventoryItem(locationId = 'default', row = {}) {
  const item = normalizeItem(row);
  if (!item) return { ok: false, code: 'BAD_PAYLOAD' };
  const rows = await listInventory(locationId);
  const i = rows.findIndex((x) => x.id === item.id);
  if (i >= 0) rows[i] = { ...rows[i], ...item, updatedAt: new Date().toISOString() };
  else rows.push(item);
  await writeRaw(locationId, rows);
  return { ok: true, item: i >= 0 ? rows[i] : item };
}

export async function adjustInventoryStock(locationId = 'default', id = '', delta = 0) {
  const target = String(id || '').trim();
  const d = Number(delta);
  if (!target || !Number.isFinite(d) || !Number.isInteger(d)) return { ok: false, code: 'BAD_PAYLOAD' };
  const rows = await listInventory(locationId);
  const i = rows.findIndex((x) => x.id === target);
  if (i < 0) return { ok: false, code: 'NOT_FOUND' };
  rows[i].stock = Math.max(0, rows[i].stock + d);
  rows[i].updatedAt = new Date().toISOString();
  await writeRaw(locationId, rows);
  return { ok: true, item: rows[i] };
}

export async function deleteInventoryItem(locationId = 'default', id = '') {
  const target = String(id || '').trim();
  if (!target) return { ok: false, code: 'NO_ID' };
  const rows = await listInventory(locationId);
  await writeRaw(locationId, rows.filter((x) => x.id !== target));
  return { ok: true };
}
