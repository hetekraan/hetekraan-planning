import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import xlsx from 'xlsx';

const SOURCE_XLSX =
  process.argv[2] ||
  '/Users/daanklein/Documents/HETEKRAAN/prijslijst_bewerkt.xlsx';
const OUTPUT_JSON = path.resolve(process.cwd(), 'public/data/catalog-v1.json');

const SHEET_CATEGORY_MAP = {
  kranen: 'kraan',
  quookers: 'quooker',
  'service producten': 'service',
};

function normalizeText(v) {
  if (v == null) return '';
  return String(v).trim().replace(/\s+/g, ' ');
}

function toPrice(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }
  const s = String(v).replace(',', '.').replace(/[^\d.-]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function detectColumns(header) {
  const cols = header.map((h) => normalizeText(h).toLowerCase());
  const nameIdx = cols.findIndex((c) => c.includes('productnaam') || c.includes('naam'));
  const priceIdx = cols.findIndex(
    (c) => c.includes('verkoopprijs') || c.includes('prijs')
  );
  return { nameIdx, priceIdx };
}

function parseSheet(sheetName, ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (!rows.length) return [];
  const header = rows[0] || [];
  const { nameIdx, priceIdx } = detectColumns(header);
  if (nameIdx < 0 || priceIdx < 0) return [];

  const category = SHEET_CATEGORY_MAP[sheetName.toLowerCase()] || 'overig';
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = normalizeText(row[nameIdx]);
    const price = toPrice(row[priceIdx]);
    if (!name || price === null || price < 0) continue;

    const idBase = `${category}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const id = `${idBase}-${i + 1}`;
    items.push({
      id,
      category,
      name,
      price,
      sourceSheet: sheetName,
      aliases: [name.toLowerCase(), category],
      searchText: `${name} ${category} ${sheetName}`.toLowerCase(),
      active: true,
    });
  }
  return items;
}

function main() {
  if (!fs.existsSync(SOURCE_XLSX)) {
    throw new Error(`Excel bestand niet gevonden: ${SOURCE_XLSX}`);
  }
  const wb = xlsx.readFile(SOURCE_XLSX);
  const all = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    all.push(...parseSheet(name, ws));
  }
  const payload = {
    version: 1,
    sourceFile: SOURCE_XLSX,
    generatedAt: new Date().toISOString(),
    itemCount: all.length,
    items: all,
  };
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(payload, null, 2));
  console.log(`catalog-v1 geschreven: ${OUTPUT_JSON} (${all.length} items)`);
}

main();
