import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNameForMatch,
  normalizeSku,
  resolveInventoryItemForLine,
  resolveLineSku,
} from '../lib/inventory-deduct-match.js';

function mapsFrom({ prices = [], inventory = [] } = {}) {
  const priceById = new Map(prices.map((x) => [String(x.id).trim(), x]));
  const priceBySku = new Map(
    prices.filter((x) => normalizeSku(x.sku)).map((x) => [normalizeSku(x.sku), x])
  );
  const priceByName = new Map(
    prices.map((x) => [normalizeNameForMatch(x.description || x.name || x.naam || ''), x])
  );
  const invBySku = new Map(
    inventory.filter((x) => normalizeSku(x.sku)).map((x) => [normalizeSku(x.sku), x])
  );
  const invById = new Map(inventory.map((x) => [String(x.id).trim(), x]));
  return { priceById, priceBySku, priceByName, invBySku, invById };
}

test('resolveLineSku: matches via priceId then sku field', () => {
  const prices = [{ id: 'pr_cube', sku: '8720823103673', name: 'CUBE' }];
  const m = mapsFrom({ prices });
  assert.equal(resolveLineSku({ priceId: 'pr_cube', desc: 'CUBE' }, m.priceById, m.priceBySku, m.priceByName), '8720823103673');
  assert.equal(resolveLineSku({ sku: '8720823103673' }, m.priceById, m.priceBySku, m.priceByName), '8720823103673');
});

test('resolveLineSku: empty when price row has no sku', () => {
  const prices = [{ id: 'pr_cube', sku: null, name: 'CUBE', description: 'CUBE' }];
  const m = mapsFrom({ prices });
  assert.equal(resolveLineSku({ priceId: 'pr_cube', desc: 'CUBE' }, m.priceById, m.priceBySku, m.priceByName), '');
  assert.equal(resolveLineSku({ desc: 'CUBE' }, m.priceById, m.priceBySku, m.priceByName), '');
});

test('resolveInventoryItemForLine: sku path preferred when both available', () => {
  const prices = [{ id: 'pr_1', sku: 'SKU-1', name: 'Widget' }];
  const inventory = [{ id: 'pr_1', sku: 'SKU-1', name: 'Widget', stock: 5 }];
  const m = mapsFrom({ prices, inventory });
  const out = resolveInventoryItemForLine({ priceId: 'pr_1', desc: 'Widget' }, m);
  assert.equal(out.match, 'sku');
  assert.equal(out.item.id, 'pr_1');
  assert.equal(out.sku, 'sku-1');
});

test('resolveInventoryItemForLine: id fallback when product has no sku (CUBE case)', () => {
  const prices = [{ id: 'pr_1780003820593_7twu26', sku: null, name: 'CUBE', description: 'CUBE' }];
  const inventory = [
    { id: 'pr_1780003820593_7twu26', sku: null, name: 'CUBE', stock: 6, minStock: 3 },
  ];
  const m = mapsFrom({ prices, inventory });
  const out = resolveInventoryItemForLine(
    { priceId: 'pr_1780003820593_7twu26', desc: 'CUBE', quantity: 1 },
    m
  );
  assert.equal(out.match, 'id_fallback');
  assert.equal(out.item.id, 'pr_1780003820593_7twu26');
  assert.equal(out.productId, 'pr_1780003820593_7twu26');
  assert.equal(out.sku, '');
});

test('resolveInventoryItemForLine: id fallback via name when line has no priceId', () => {
  const prices = [{ id: 'pr_flex', sku: '', name: 'Drukknop FLEX chroom', description: 'Drukknop FLEX chroom' }];
  const inventory = [{ id: 'pr_flex', sku: null, name: 'Drukknop FLEX chroom', stock: 17 }];
  const m = mapsFrom({ prices, inventory });
  const out = resolveInventoryItemForLine({ desc: 'Drukknop FLEX chroom' }, m);
  assert.equal(out.match, 'id_fallback');
  assert.equal(out.item.id, 'pr_flex');
});

test('resolveInventoryItemForLine: no_sku_match when unknown product', () => {
  const m = mapsFrom({ prices: [], inventory: [] });
  const out = resolveInventoryItemForLine({ desc: 'Onbekend ding' }, m);
  assert.equal(out.match, 'no_sku_match');
  assert.equal(out.item, null);
});
