#!/usr/bin/env node
/**
 * Tijdelijk: alle blocked slots verwijderen via de eigen API.
 *
 * 1) POST https://planning.hetekraan.nl/api/ghl?action=auth
 *    Body: { "user": "daan", "password": "<wachtwoord>" }
 *    Wachtwoord: interactieve prompt, of env HK_CLEANUP_PASSWORD.
 *
 * 2) POST https://planning.hetekraan.nl/api/ghl?action=bulkDeleteBlockedSlots
 *    Header: X-HK-Auth: <token>
 *    Body: { confirm, startDate, endDate } (zie hieronder).
 *
 * Run: node scripts/cleanup-blocks.js
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const AUTH_URL = 'https://planning.hetekraan.nl/api/ghl?action=auth';
const BULK_DELETE_URL =
  'https://planning.hetekraan.nl/api/ghl?action=bulkDeleteBlockedSlots';

const BULK_BODY = {
  confirm: 'VERWIJDER_ALLE_BLOKJES',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
};

async function getPassword() {
  const fromEnv = process.env.HK_CLEANUP_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  const rl = readline.createInterface({ input, output });
  try {
    const p = await rl.question('Wachtwoord voor gebruiker daan: ');
    return String(p || '').trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const password = await getPassword();
  if (!password) {
    console.error('Geen wachtwoord: zet HK_CLEANUP_PASSWORD of typ het wanneer gevraagd.');
    process.exit(1);
  }

  console.log('[1/2] Inloggen:', AUTH_URL);
  const authRes = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'daan', password }),
  });
  const authText = await authRes.text();
  let authJson = {};
  try {
    authJson = JSON.parse(authText);
  } catch {
    /* ignore */
  }
  if (!authRes.ok || !authJson.token) {
    console.error('Login mislukt:', authRes.status, authJson.error || authText.slice(0, 200));
    process.exit(1);
  }
  console.log('[1/2] OK — ingelogd als', authJson.user || 'daan');

  console.log('[2/2] bulkDeleteBlockedSlots:', BULK_DELETE_URL);
  console.log('[2/2] body:', JSON.stringify(BULK_BODY));
  const delRes = await fetch(BULK_DELETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-HK-Auth': authJson.token,
    },
    body: JSON.stringify(BULK_BODY),
  });
  const delText = await delRes.text();
  let delJson = {};
  try {
    delJson = JSON.parse(delText);
  } catch {
    /* ignore */
  }

  if (!delRes.ok) {
    console.error('Bulk delete mislukt:', delRes.status, delJson.error || delText.slice(0, 500));
    process.exit(1);
  }

  console.log('--- resultaat ---');
  console.log(JSON.stringify(delJson, null, 2));
  const deleted = delJson.deleted ?? 0;
  const attempted = delJson.attempted ?? 0;
  const totalFound = delJson.totalFound;
  console.log(
    `Samenvatting: ${deleted} blok(ken) verwijderd (van ${attempted} geprobeerd` +
      (totalFound != null ? `, ${totalFound} gevonden in bereik` : '') +
      ').'
  );
  if (delJson.truncated) {
    console.warn(
      'Let op: run was afgekapt (max per run). Voer het script opnieuw uit om de rest te verwijderen.'
    );
  }
  if (Array.isArray(delJson.failed) && delJson.failed.length) {
    console.warn('Mislukt (eerste entries):', delJson.failed.length, delJson.failed.slice(0, 5));
  }
  if (delJson.message) console.log('Bericht:', delJson.message);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
