import { Redis } from '@upstash/redis';
import { listPrices } from './prices-store.js';

const PREFIX = 'hk:inventory';
const WARNINGS_KEY = 'hk:inventory:warnings';
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

export function isInventoryStoreConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function key(locationId) {
  return `${redisPrefix()}${PREFIX}:${String(locationId || 'default').trim() || 'default'}`;
}

function warningsKey() {
  return `${redisPrefix()}${WARNINGS_KEY}`;
}

function normalizeItem(row = {}) {
  const id = String(row.id || '').trim() || `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const name = String(row.name || '').trim();
  const skuRaw = String(row.sku || '').trim();
  const category = String(row.category || 'Serviceproducten').trim();
  const stock = Number(row.stock);
  const minStock = Number(row.minStock);
  if (!name || !Number.isFinite(stock) || !Number.isFinite(minStock)) return null;
  return {
    id,
    name,
    sku: skuRaw || null,
    category,
    stock: Math.max(0, Math.floor(stock)),
    minStock: Math.max(0, Math.floor(minStock)),
    inkoopprijs: Number.isFinite(Number(row.inkoopprijs)) ? Math.round(Number(row.inkoopprijs) * 100) / 100 : 0,
    updatedAt: new Date().toISOString(),
  };
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

export async function getInventoryWarnings(locationId = 'default') {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.get(warningsKey());
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else {
    try {
      const parsed = JSON.parse(String(raw || '[]'));
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
  }
  const loc = String(locationId || 'default');
  if (loc === '__all__') return list;
  return list.filter((x) => String(x?.locationId || 'default') === loc);
}

export async function setInventoryWarnings(locationId = 'default', warnings = []) {
  const redis = getRedis();
  if (!redis) return false;
  const existing = await getInventoryWarnings('__all__').catch(() => []);
  const loc = String(locationId || 'default');
  const keptOther = existing.filter((x) => String(x?.locationId || 'default') !== loc);
  const nextForLoc = (Array.isArray(warnings) ? warnings : []).map((w) => ({
    itemId: String(w?.itemId || '').trim(),
    itemName: String(w?.itemName || '').trim(),
    stock: Number(w?.stock) || 0,
    minStock: Number(w?.minStock) || 0,
    locationId: loc,
    updatedAt: new Date().toISOString(),
  })).filter((w) => w.itemId && w.itemName);
  await redis.set(warningsKey(), JSON.stringify([...keptOther, ...nextForLoc]));
  return true;
}

export async function refreshInventoryWarnings(locationId = 'default') {
  const items = await listInventory(locationId);
  const warnings = items
    .filter((x) => Number.isFinite(Number(x.stock)) && Number.isFinite(Number(x.minStock)) && x.stock < x.minStock)
    .map((x) => ({
      itemId: x.id,
      itemName: x.name,
      stock: x.stock,
      minStock: x.minStock,
    }));
  await setInventoryWarnings(locationId, warnings);
  return warnings;
}

export async function listInventory(locationId = 'default') {
  const [rows, products] = await Promise.all([readRaw(locationId), listPrices(locationId)]);
  const normRows = rows.map((x) => normalizeItem(x)).filter(Boolean);
  const byId = new Map(normRows.map((x) => [String(x.id), x]));
  const next = [];
  let changed = false;
  for (const p of products) {
    const productId = String(p.id || '').trim();
    if (!productId) continue;
    const existing = byId.get(productId);
    const merged = normalizeItem({
      id: productId,
      name: String(p.naam || p.name || p.description || '').trim(),
      sku: String(p.sku || '').trim() || null,
      category: String(p.categorie || p.category || 'Serviceproducten').trim(),
      stock: Number(existing?.stock ?? 0),
      minStock: Number(existing?.minStock ?? 0),
      inkoopprijs: Number(p.inkoopprijs ?? 0),
      updatedAt: existing?.updatedAt,
    });
    if (!merged) continue;
    if (!existing) changed = true;
    if (
      existing &&
      (String(existing.name) !== String(merged.name) ||
        String(existing.sku || '') !== String(merged.sku || '') ||
        String(existing.category) !== String(merged.category) ||
        Number(existing.inkoopprijs || 0) !== Number(merged.inkoopprijs || 0))
    ) {
      changed = true;
    }
    next.push(merged);
  }
  if (changed || next.length !== normRows.length) {
    await writeRaw(locationId, next);
  }
  return next;
}

export async function upsertInventoryItem(locationId = 'default', row = {}) {
  const products = await listPrices(locationId);
  const productById = new Map(products.map((p) => [String(p.id || '').trim(), p]));
  const inputId = String(row?.id || '').trim();
  const source = productById.get(inputId);
  if (!source) return { ok: false, code: 'NOT_FOUND' };
  const item = normalizeItem({
    id: inputId,
    name: source.naam || source.name || source.description,
    sku: source.sku || null,
    category: source.categorie || source.category || 'Serviceproducten',
    inkoopprijs: source.inkoopprijs || 0,
    stock: Number(row.stock),
    minStock: Number(row.minStock),
  });
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
