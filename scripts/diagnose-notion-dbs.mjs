#!/usr/bin/env node
/**
 * Diagnose: bevestig dat NOTION_DB_KLANTEN / NOTION_DB_KLUSSEN naar de JUISTE
 * databases wijzen en dat de property-namen exact kloppen met wat de code verwacht.
 *
 * Draai lokaal met de waarden uit Vercel (worden NIET geprint):
 *   NOTION_TOKEN=secret_xxx \
 *   NOTION_DB_KLANTEN=<id> \
 *   NOTION_DB_KLUSSEN=<id> \
 *   node scripts/diagnose-notion-dbs.mjs
 *
 * Read-only: doet alleen GET /v1/databases/{id}. Wijzigt niets.
 */

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const EXPECTED = {
  KLANTEN: ['Naam', 'Adres', 'Telefoon', 'Email', 'Quooker-model', 'Bron', 'GHL-ID', 'Klussen'],
  KLUSSEN: ['Titel', 'Klant', 'Datum', 'Type werk', 'Omzet', 'Materiaalkosten', 'Marge', 'Status', 'Planner-link'],
};

function hexOf(s) {
  return Buffer.from(String(s), 'utf8').toString('hex');
}

async function getDatabase(token, dbId) {
  const res = await fetch(`${NOTION_API_BASE}/databases/${encodeURIComponent(dbId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function titleOf(db) {
  return Array.isArray(db?.title) ? db.title.map((t) => t?.plain_text || '').join('') : '(geen titel)';
}

function reportDb(label, dbId, expectedNames, result) {
  console.log(`\n========== ${label} ==========`);
  console.log(`db-id: ${dbId || '(LEEG!)'}`);
  if (!result.ok) {
    console.log(`FOUT: HTTP ${result.status} — ${result.data?.code || ''} ${result.data?.message || ''}`);
    return;
  }
  const db = result.data;
  console.log(`Notion titel: "${titleOf(db)}"`);
  const props = db?.properties && typeof db.properties === 'object' ? db.properties : {};
  const actualNames = Object.keys(props);
  console.log('property-namen (exact):');
  for (const name of actualNames) {
    const suspicious = /[\u00a0\u2010\u2011\u2012\u2013\u2014\u2015]/.test(name) ? '  <-- LET OP: bijzonder unicode-teken' : '';
    console.log(`  - "${name}"  [type=${props[name]?.type}]  hex=${hexOf(name)}${suspicious}`);
  }
  const actualSet = new Set(actualNames);
  const missing = expectedNames.filter((n) => !actualSet.has(n));
  const extra = actualNames.filter((n) => !expectedNames.includes(n));
  console.log(missing.length ? `ONTBREEKT (verwacht, niet gevonden): ${missing.join(', ')}` : 'Alle verwachte property-namen aanwezig ✓');
  if (extra.length) console.log(`Extra properties (mag, ter info): ${extra.join(', ')}`);
}

async function main() {
  const token = String(process.env.NOTION_TOKEN || '').trim();
  const klantenId = String(process.env.NOTION_DB_KLANTEN || '').trim();
  const klussenId = String(process.env.NOTION_DB_KLUSSEN || '').trim();
  if (!token) {
    console.error('NOTION_TOKEN ontbreekt. Zet de env vars uit Vercel en draai opnieuw.');
    process.exit(1);
  }
  console.log('Verwachte GHL-ID hex (normale hyphen U+002D):', hexOf('GHL-ID'));

  const [klanten, klussen] = await Promise.all([
    klantenId ? getDatabase(token, klantenId) : Promise.resolve({ ok: false, status: 0, data: { message: 'NOTION_DB_KLANTEN leeg' } }),
    klussenId ? getDatabase(token, klussenId) : Promise.resolve({ ok: false, status: 0, data: { message: 'NOTION_DB_KLUSSEN leeg' } }),
  ]);

  reportDb('NOTION_DB_KLANTEN → moet "Klanten" zijn', klantenId, EXPECTED.KLANTEN, klanten);
  reportDb('NOTION_DB_KLUSSEN → moet "Klussen" zijn', klussenId, EXPECTED.KLUSSEN, klussen);

  // Swap-detectie: klopt de titel bij de rol?
  console.log('\n========== CONCLUSIE ==========');
  if (klanten.ok) {
    const t = titleOf(klanten.data).toLowerCase();
    console.log(`NOTION_DB_KLANTEN wijst naar een db met titel "${titleOf(klanten.data)}" → ${t.includes('klant') ? 'OK' : 'FOUT: lijkt niet de Klanten-db!'}`);
  }
  if (klussen.ok) {
    const t = titleOf(klussen.data).toLowerCase();
    console.log(`NOTION_DB_KLUSSEN wijst naar een db met titel "${titleOf(klussen.data)}" → ${t.includes('klus') ? 'OK' : 'FOUT: lijkt niet de Klussen-db!'}`);
  }
}

main().catch((err) => {
  console.error('Onverwachte fout:', err?.message || String(err));
  process.exit(1);
});
