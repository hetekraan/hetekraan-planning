import { listInventory } from '../lib/inventory-store.js';
import { listPrices } from '../lib/prices-store.js';
import { ghlLocationIdFromEnv } from '../lib/ghl-env-ids.js';
import { upsertInventoryItem } from '../lib/inventory-store.js';

function locationId() {
  return ghlLocationIdFromEnv() || process.env.GHL_LOCATION_ID || 'default';
}

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreNameMatch(invName, priceName) {
  const a = normalizeText(invName);
  const b = normalizeText(priceName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 90;
  const aWords = new Set(a.split(' ').filter(Boolean));
  const bWords = new Set(b.split(' ').filter(Boolean));
  let overlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) overlap += 1;
  }
  if (!overlap) return 0;
  const ratio = overlap / Math.max(aWords.size, bWords.size);
  return Math.round(ratio * 80);
}

function findBestPriceMatch(inventoryItem, priceItems) {
  const invName = String(inventoryItem?.name || '').trim();
  let best = null;
  let bestScore = 0;
  for (const p of priceItems) {
    const name = String(p?.description || p?.name || '').trim();
    const score = scoreNameMatch(invName, name);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  if (!best || bestScore < 60) return null;
  return { price: best, score: bestScore };
}

async function main() {
  const loc = locationId();
  const [inventoryItems, priceItems] = await Promise.all([listInventory(loc), listPrices(loc)]);

  console.log(`\n[sku-migration-preview] location=${loc}`);
  console.log(`[sku-migration-preview] inventory=${inventoryItems.length}, prices=${priceItems.length}\n`);

  const withSku = inventoryItems.filter((x) => String(x?.sku || '').trim());
  const withoutSku = inventoryItems.filter((x) => !String(x?.sku || '').trim());
  console.log(`[sku-migration-preview] already_has_sku=${withSku.length}`);
  console.log(`[sku-migration-preview] needs_match=${withoutSku.length}\n`);

  let matched = 0;
  let noMatch = 0;
  for (const item of withoutSku) {
    const best = findBestPriceMatch(item, priceItems);
    if (!best) {
      noMatch += 1;
      console.log(`[NO_MATCH] inventory="${item.name}"`);
      continue;
    }
    matched += 1;
    const sku = String(best.price?.sku || '').trim() || '(prijsitem heeft geen SKU)';
    const priceName = String(best.price?.description || best.price?.name || '').trim();
    console.log(
      `[MATCH] inventory="${item.name}" -> price="${priceName}" | suggested_sku="${sku}" | score=${best.score}`
    );
    if (sku && sku !== '(prijsitem heeft geen SKU)') {
      const out = await upsertInventoryItem(loc, { ...item, sku });
      if (out?.ok) {
        console.log(`[UPDATED] inventory="${item.name}" | sku="${sku}"`);
      } else {
        console.log(`[UPDATE_FAILED] inventory="${item.name}" | code="${String(out?.code || 'UNKNOWN')}"`);
      }
    } else {
      console.log(`[SKIPPED_NO_SKU] inventory="${item.name}"`);
    }
  }

  console.log('\n[sku-migration-preview] done');
  console.log(`[sku-migration-preview] matched=${matched}, no_match=${noMatch}`);
  console.log('[sku-migration-preview] writes completed');
}

main().catch((err) => {
  console.error('[sku-migration-preview] failed:', err?.message || err);
  process.exitCode = 1;
});
