import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterAndSortBestellijstItems,
  statusForInventoryItem,
} from '../lib/bestellijst-rows.js';

test('statusForInventoryItem: out / low / ok', () => {
  assert.equal(statusForInventoryItem({ stock: 0, minStock: 3 }), 'out');
  assert.equal(statusForInventoryItem({ stock: 2, minStock: 3 }), 'low');
  assert.equal(statusForInventoryItem({ stock: 5, minStock: 3 }), 'ok');
});

test('filterAndSortBestellijstItems: includes out and low, hides ok, out first', () => {
  const rows = filterAndSortBestellijstItems([
    { id: 'ok', name: 'OK', stock: 10, minStock: 2 },
    { id: 'low', name: 'Low', stock: 1, minStock: 3 },
    { id: 'out', name: 'Out', stock: 0, minStock: 2 },
    { id: 'low2', name: 'Low2', stock: 2, minStock: 5 },
  ]);
  assert.deepEqual(
    rows.map((x) => x.id),
    ['out', 'low', 'low2']
  );
});

test('filterAndSortBestellijstItems: stock 0 with minStock 0 still shown as out', () => {
  const rows = filterAndSortBestellijstItems([
    { id: 'fusion', name: 'Fusion Round messing patina', stock: 0, minStock: 0 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(statusForInventoryItem(rows[0]), 'out');
});

test('planner-bestellijst.js keeps out + Uitverkocht in render path', () => {
  const fp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app', 'planner-bestellijst.js');
  const src = fs.readFileSync(fp, 'utf8');
  assert.match(src, /st === 'low' \|\| st === 'out'/);
  assert.match(src, /Uitverkocht/);
  assert.match(src, /status-pill \$\{st\}/);
});
