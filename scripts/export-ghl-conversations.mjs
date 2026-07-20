// scripts/export-ghl-conversations.mjs
//
// READ-ONLY export van alle GHL Conversations naar tekstbestanden voor stijlanalyse,
// GESPLITST per kanaal (WhatsApp / SMS / Email / Overig).
//
// Doel: schrijfstijl-analyse per kanaal. Essentieel onderscheid KLANT / IK / BOT,
// zodat een stijlprofiel op de mens (IK) ontstaat en niet op de GHL-bot.
//
// Template-detectie: IK-berichten die (bijna-)letterlijk bij >=5 verschillende klanten voorkomen,
// of die een bekend sjabloon-patroon matchen (review-uitnodiging, offerte-in-mail, betaallink,
// afspraakbevestiging), worden geherclassificeerd naar BOT. Zo blijft het IK-profiel puur natuurlijk.
// Er wordt een apart template-rapport weggeschreven met de gevonden sjablonen + aantallen.
//
// GHL: uitsluitend GET-calls (read-only). Enige writes = de output-bestanden.
//
// Gebruik:
//   set -a && source .env.local && set +a
//   node scripts/export-ghl-conversations.mjs
//   node scripts/export-ghl-conversations.mjs --max=50   # (optioneel) beperk aantal conversaties voor een testrun
//
// Vereist env: GHL_API_KEY, GHL_LOCATION_ID

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fetchWithRetry } from '../lib/retry.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = (process.env.GHL_API_KEY || '').trim();
const GHL_LOCATION_ID = (process.env.GHL_LOCATION_ID || '').trim().replace(/^["']|["']$/g, '');
const GHL_VERSION = '2021-04-15';

const OUTPUT_DIR = path.resolve(process.cwd(), 'scripts/output');
const CONV_PAGE_LIMIT = 100;
const MSG_PAGE_LIMIT = 100;
const PROGRESS_EVERY = 20;
const POLITE_DELAY_MS = 120;

const MAX_CONV_ARG = (() => {
  const a = process.argv.find((x) => x.startsWith('--max='));
  if (!a) return Infinity;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

// Namen/patronen die op een test-conversatie duiden → overslaan.
const TEST_PATTERNS = [
  /\btest(en|je|je2)?\b/i,
  /\btests?\b/i,
  /jantje/i,
  /jan\s+janssen/i,
  /john\s+doe/i,
  /probeer/i,
  /\bdemo\b/i,
  /voorbeeld/i,
  /dummy/i,
  /lorem/i,
  /\basdf+\b/i,
  /\bqwerty\b/i,
  /\bx{3,}\b/i,
];

// Bronnen die op een MENS duiden (bericht handmatig verstuurd vanuit de GHL-app/web).
// GHL vult userId in dit account niet betrouwbaar (vaak ""), dus `source` is leidend.
const HUMAN_SOURCES = new Set(['app', 'mobile_app', 'web']);
// Al het andere outbound (workflow, campaign, bulk_actions, api, integration, …) = automatisch → BOT.

// Template-detectie: een IK-bericht dat (bijna-)letterlijk bij >=N verschillende klanten voorkomt
// is waarschijnlijk een sjabloon → herclassificeren naar BOT, zodat het IK-profiel puur natuurlijk blijft.
const TEMPLATE_MIN_DISTINCT_CONTACTS = 5;
// Minimale genormaliseerde lengte voor frequentie-detectie, zodat natuurlijke korte antwoorden
// ("bedankt", "ja klopt", "top") niet onterecht als template worden gemarkeerd.
const TEMPLATE_MIN_LEN = 50;
// Bekende sjablonen — altijd als template markeren, ongeacht frequentie/lengte.
const KNOWN_TEMPLATE_PATTERNS = [
  { label: 'Review-uitnodiging', re: /korte review|review\b[^.]*achterlaten|review voor ons/i },
  { label: 'Offerte-in-mail', re: /offerte in (uw|je) mail|de offerte[^.]*\bmail\b/i },
  { label: 'Betaallink', re: /betaallink|link om te betalen|klik[^.]*om te betalen/i },
  { label: 'Afspraakbevestiging', re: /uw afspraak is (ingepland|bevestigd)|we hebben uw afspraak (ingepland|bevestigd)/i },
];

function ghlHeaders() {
  return {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const dtFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function toDate(v) {
  if (v == null || v === '') return null;
  // GHL levert ISO-strings of epoch-ms.
  const n = Number(v);
  const d = Number.isFinite(n) && String(v).trim() === String(n) ? new Date(n) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(v) {
  const d = toDate(v);
  return d ? dtFmt.format(d) : '(datum onbekend)';
}

function fmtDate(v) {
  const d = toDate(v);
  return d ? dFmt.format(d) : '(datum onbekend)';
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isTestName(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  return TEST_PATTERNS.some((re) => re.test(s));
}

/** Kanaal op basis van GHL messageType. Retour: 'whatsapp' | 'sms' | 'email' | 'overig' | 'activity'. */
function classifyChannel(messageType, typeNum) {
  const t = String(messageType || '').toUpperCase();
  if (t.includes('ACTIVITY')) return 'activity';
  if (t.includes('WHATSAPP')) return 'whatsapp';
  if (t.includes('SMS')) return 'sms';
  if (t.includes('EMAIL')) return 'email';
  if (t.includes('CALL')) return 'overig';
  if (t.includes('FACEBOOK') || t.includes('INSTAGRAM') || t.includes('IG') || t.includes('GMB') ||
      t.includes('WEBCHAT') || t.includes('LIVE_CHAT') || t.includes('CHAT') || t.includes('REVIEW')) {
    return 'overig';
  }
  // Fallback op numerieke type als messageType leeg is (best-effort).
  if (!t && Number.isFinite(Number(typeNum))) return 'overig';
  return 'overig';
}

/** Rol: KLANT (inbound) / IK (mens: outbound via GHL-app) / BOT (automatisch: workflow/api/campaign). */
function classifyRole(msg) {
  const dir = String(msg?.direction || '').toLowerCase();
  if (dir === 'inbound') return 'KLANT';
  const source = String(msg?.source || '').toLowerCase();
  const userId = String(msg?.userId || '').trim();
  if (HUMAN_SOURCES.has(source) || userId) return 'IK';
  return 'BOT';
}

// GHL Conversations Search pagineert met een cursor (startAfterDate), NIET met page-nummers.
// (page= wordt genegeerd en levert steeds dezelfde eerste pagina.)
/** Normaliseer tekst tot een stabiele template-sleutel (case/leestekens/getallen/urls weg). */
function normalizeForTemplate(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bekend sjabloon? Retour label of null. */
function matchKnownTemplate(text) {
  const s = String(text || '');
  for (const p of KNOWN_TEMPLATE_PATTERNS) {
    if (p.re.test(s)) return p.label;
  }
  return null;
}

async function getConversationPage(startAfterDate) {
  const params = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    limit: String(CONV_PAGE_LIMIT),
    sortBy: 'last_message_date',
    sort: 'desc',
  });
  if (startAfterDate != null) params.set('startAfterDate', String(startAfterDate));
  const url = `${GHL_BASE}/conversations/search?${params.toString()}`;
  const res = await fetchWithRetry(url, { headers: ghlHeaders(), _timeoutMs: 20000 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`conversations/search cursor=${startAfterDate ?? 'start'} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { conversations: data?.conversations || [], total: Number(data?.total || 0) };
}

async function getAllMessages(conversationId) {
  const all = [];
  let lastMessageId = null;
  let guard = 0;
  do {
    guard += 1;
    const qs = `limit=${MSG_PAGE_LIMIT}${lastMessageId ? `&lastMessageId=${encodeURIComponent(lastMessageId)}` : ''}`;
    const url = `${GHL_BASE}/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`;
    const res = await fetchWithRetry(url, { headers: ghlHeaders(), _timeoutMs: 20000 });
    if (!res.ok) {
      // Niet fataal: log en stop met wat we hebben.
      console.warn(`  ⚠️  messages ${conversationId} → HTTP ${res.status}`);
      break;
    }
    const data = await res.json().catch(() => ({}));
    const batch = data?.messages?.messages || [];
    const nextPage = Boolean(data?.messages?.nextPage);
    if (!batch.length) break;
    all.push(...batch);
    // Batches komen nieuw→oud; oudste id in batch = cursor voor nog oudere berichten.
    lastMessageId = batch[batch.length - 1]?.id || null;
    if (!nextPage || !lastMessageId) break;
  } while (guard < 100);
  return all;
}

function pickContactName(conv) {
  const cand =
    conv?.fullName ||
    conv?.contactName ||
    [conv?.firstName, conv?.lastName].filter(Boolean).join(' ').trim() ||
    conv?.email ||
    conv?.phone ||
    '';
  return String(cand || '').trim() || '(onbekend)';
}

function dominantChannel(counts) {
  // Voorkeursvolgorde bij gelijkspel.
  const order = ['email', 'whatsapp', 'sms', 'overig'];
  let best = null;
  let bestN = -1;
  for (const ch of order) {
    const n = counts[ch] || 0;
    if (n > bestN) {
      bestN = n;
      best = ch;
    }
  }
  return bestN > 0 ? best : null;
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}

function main() {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.error('❌ Ontbrekende env: GHL_API_KEY en/of GHL_LOCATION_ID.');
    console.error('   Laad eerst je env: set -a && source .env.local && set +a');
    process.exitCode = 1;
    return Promise.resolve();
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const dateStamp = dFmt.format(new Date()).split('-').reverse().join('-'); // YYYY-MM-DD

  return run(dateStamp);
}

async function run(dateStamp) {
  console.log(`[export] start — location=${GHL_LOCATION_ID}`);

  // 1. Alle conversaties ophalen via cursor-paginatie (startAfterDate = lastMessageDate).
  //    Dedupe op conversation-id (de cursor-grens levert het randbericht soms dubbel).
  const conversations = [];
  const seenConvIds = new Set();
  let cursor = null;
  let total = 0;
  let guard = 0;
  do {
    guard += 1;
    const { conversations: batch, total: t } = await getConversationPage(cursor);
    total = t || total;
    if (!batch.length) break;
    let added = 0;
    for (const c of batch) {
      const cid = String(c?.id || '').trim();
      if (!cid || seenConvIds.has(cid)) continue;
      seenConvIds.add(cid);
      conversations.push(c);
      added += 1;
    }
    console.log(`[export] conversaties opgehaald: ${conversations.length}${total ? `/${total}` : ''} (batch ${guard}, nieuw=${added})`);
    const last = batch[batch.length - 1];
    const nextCursor = last?.lastMessageDate != null ? Number(last.lastMessageDate) : null;
    if (batch.length < CONV_PAGE_LIMIT) break;
    if (nextCursor == null || nextCursor === cursor) break; // cursor niet meer opgeschoven → klaar
    if (added === 0) break; // geen nieuwe id's meer → klaar
    cursor = nextCursor;
    await sleep(POLITE_DELAY_MS);
  } while (guard < 500);

  // 2. Verzamel alle conversaties + berichten (nog GÉÉN template-herclassificatie —
  //    die vereist een globale frequentie-analyse over ALLE IK-berichten samen).
  const convData = [];
  let processed = 0;
  let skippedTest = 0;
  let skippedEmpty = 0;
  let skippedNoContact = 0;

  const limit = Math.min(conversations.length, MAX_CONV_ARG);

  for (let i = 0; i < limit; i += 1) {
    const conv = conversations[i];
    processed += 1;
    if (processed % PROGRESS_EVERY === 0) {
      console.log(`[export] voortgang: ${processed}/${limit} verwerkt (test-skip=${skippedTest}, leeg-skip=${skippedEmpty})`);
    }

    const contactId = conv?.contactId || '';
    if (!contactId) {
      skippedNoContact += 1;
      continue;
    }
    const name = pickContactName(conv);
    if (isTestName(name)) {
      skippedTest += 1;
      continue;
    }

    let rawMessages = [];
    try {
      rawMessages = await getAllMessages(conv.id);
    } catch (err) {
      console.warn(`  ⚠️  kon berichten niet ophalen voor ${name} (${conv.id}): ${err?.message || err}`);
    }
    await sleep(POLITE_DELAY_MS);

    // Normaliseer + filter op echte inhoud (geen activity, moet body hebben).
    const msgs = rawMessages
      .map((m) => {
        const channel = classifyChannel(m?.messageType, m?.type);
        const role = classifyRole(m);
        const text = stripHtml(m?.body);
        return {
          channel,
          role,
          text,
          ts: m?.dateAdded ?? m?.dateUpdated ?? null,
          tsNum: toDate(m?.dateAdded ?? m?.dateUpdated)?.getTime() ?? 0,
        };
      })
      .filter((m) => m.channel !== 'activity' && m.text);

    // Filter #2: tenminste één bericht van/naar een echte klant.
    if (!msgs.length) {
      skippedEmpty += 1;
      continue;
    }

    // Chronologisch (oud → nieuw).
    msgs.sort((a, b) => a.tsNum - b.tsNum);

    // Kanaal per conversatie = dominante kanaal van de inhoudsberichten.
    const counts = {};
    for (const m of msgs) counts[m.channel] = (counts[m.channel] || 0) + 1;
    const channel = dominantChannel(counts) || 'overig';

    convData.push({ name, contactId, channel, msgs });
  }

  console.log(
    `[export] verwerkt=${processed} | test-skip=${skippedTest} | leeg-skip=${skippedEmpty} | geen-contact-skip=${skippedNoContact}`
  );

  // 3. Template-detectie (frequentie + bekende patronen) over IK-berichten.
  const ikBefore = convData.reduce((s, c) => s + c.msgs.filter((m) => m.role === 'IK').length, 0);

  const freqMap = new Map(); // normKey -> { contacts:Set, count, sample }
  for (const c of convData) {
    for (const m of c.msgs) {
      if (m.role !== 'IK') continue;
      const key = normalizeForTemplate(m.text);
      if (key.length < TEMPLATE_MIN_LEN) continue;
      let e = freqMap.get(key);
      if (!e) {
        e = { contacts: new Set(), count: 0, sample: m.text };
        freqMap.set(key, e);
      }
      e.contacts.add(c.contactId);
      e.count += 1;
    }
  }
  const freqTemplateKeys = new Set();
  for (const [key, e] of freqMap) {
    if (e.contacts.size >= TEMPLATE_MIN_DISTINCT_CONTACTS) freqTemplateKeys.add(key);
  }

  // 4. Herclassificeer template-IK → BOT en tel per template.
  const knownCounts = new Map(); // label -> count
  const freqCounts = new Map(); // normKey -> { count, contacts, sample }
  let templateReclassified = 0;
  for (const c of convData) {
    for (const m of c.msgs) {
      if (m.role !== 'IK') continue;
      const known = matchKnownTemplate(m.text);
      const key = normalizeForTemplate(m.text);
      const isFreq = key.length >= TEMPLATE_MIN_LEN && freqTemplateKeys.has(key);
      if (!known && !isFreq) continue;
      m.role = 'BOT';
      m.template = true;
      templateReclassified += 1;
      if (known) {
        knownCounts.set(known, (knownCounts.get(known) || 0) + 1);
      } else {
        const src = freqMap.get(key);
        const fc = freqCounts.get(key) || { count: 0, contacts: src?.contacts || new Set(), sample: src?.sample || m.text };
        fc.count += 1;
        freqCounts.set(key, fc);
      }
    }
  }
  const ikAfter = ikBefore - templateReclassified;
  console.log(`[export] templates: IK vóór=${ikBefore}, geherclassificeerd=${templateReclassified}, IK ná=${ikAfter}`);

  // 5. Bouw buckets uit de (nu geherclassificeerde) conversaties.
  const mkBucket = () => ({ convs: [], roles: { KLANT: [], IK: [], BOT: [] }, msgCount: 0, dates: [] });
  const buckets = { whatsapp: mkBucket(), sms: mkBucket(), email: mkBucket(), overig: mkBucket() };
  for (const c of convData) {
    const startedTs = c.msgs[0].ts;
    const lines = c.msgs.map((m) => `[${fmtDateTime(m.ts)}] ${m.role}: ${m.text}`);
    const block = [
      `=== Conversatie met ${c.name} (contactId: ${c.contactId}) ===`,
      `Gestart: ${fmtDate(startedTs)}`,
      '',
      ...lines,
    ].join('\n');
    const bucket = buckets[c.channel] || buckets.overig;
    bucket.convs.push(block);
    bucket.msgCount += c.msgs.length;
    for (const m of c.msgs) {
      bucket.roles[m.role].push(m.text.length);
      if (m.tsNum) bucket.dates.push(m.tsNum);
    }
  }

  // 6. Template-rapport (bestand + console).
  const freqSorted = [...freqCounts.entries()]
    .map(([, fc]) => ({ count: fc.count, distinct: fc.contacts?.size || 0, sample: fc.sample }))
    .sort((a, b) => b.count - a.count);
  const knownSorted = [...knownCounts.entries()].sort((a, b) => b[1] - a[1]);
  const reportLines = [
    'TEMPLATE-DETECTIE — GHL conversations export',
    `Gegenereerd: ${fmtDateTime(Date.now())}`,
    '',
    `IK-berichten vóór filtering:            ${ikBefore}`,
    `Geherclassificeerd naar BOT (template): ${templateReclassified}`,
    `Echte IK-berichten na filtering:        ${ikAfter}`,
    '',
    `Heuristiek frequentie: >= ${TEMPLATE_MIN_DISTINCT_CONTACTS} verschillende klanten én genormaliseerde lengte >= ${TEMPLATE_MIN_LEN} tekens.`,
    '',
    '— Bekende templates (patroon-match) —',
    ...(knownSorted.length ? knownSorted.map(([label, count]) => `  ${String(count).padStart(4)}x  ${label}`) : ['  (geen)']),
    '',
    '— Frequentie-gedetecteerde templates —',
    ...(freqSorted.length
      ? freqSorted.map((f) => {
          const oneLine = f.sample.replace(/\s+/g, ' ').trim();
          const sample = oneLine.slice(0, 160) + (oneLine.length > 160 ? '…' : '');
          return `  ${String(f.count).padStart(4)}x (${f.distinct} klanten): "${sample}"`;
        })
      : ['  (geen)']),
    '',
  ];
  const templateFile = path.join(OUTPUT_DIR, `ghl-conversations-templates-${dateStamp}.txt`);
  fs.writeFileSync(templateFile, reportLines.join('\n'));

  // WhatsApp + SMS samenvoegen als de stijl (IK-berichtlengte) vergelijkbaar is.
  const waIkAvg = avg(buckets.whatsapp.roles.IK.length ? buckets.whatsapp.roles.IK : [
    ...buckets.whatsapp.roles.KLANT,
    ...buckets.whatsapp.roles.BOT,
  ]);
  const smsIkAvg = avg(buckets.sms.roles.IK.length ? buckets.sms.roles.IK : [
    ...buckets.sms.roles.KLANT,
    ...buckets.sms.roles.BOT,
  ]);
  let mergeWaSms = false;
  if (buckets.whatsapp.convs.length && buckets.sms.convs.length && waIkAvg > 0 && smsIkAvg > 0) {
    const ratio = Math.min(waIkAvg, smsIkAvg) / Math.max(waIkAvg, smsIkAvg);
    mergeWaSms = ratio >= 0.6;
    console.log(
      `[export] WhatsApp IK-avg=${waIkAvg}, SMS IK-avg=${smsIkAvg}, ratio=${ratio.toFixed(2)} → ${mergeWaSms ? 'SAMENVOEGEN' : 'apart houden'}`
    );
  }

  const writtenFiles = [];
  const summaries = [];

  const writeBucket = (label, fileKey, srcBuckets) => {
    const merged = mergeBuckets(srcBuckets);
    if (!merged.convs.length) return;
    const summary = buildSummary(label, merged);
    const filename = path.join(OUTPUT_DIR, `ghl-conversations-${fileKey}-${dateStamp}.txt`);
    const content = [
      merged.convs.join('\n\n'),
      '',
      '========================================',
      summary.text,
      '',
    ].join('\n');
    fs.writeFileSync(filename, content);
    writtenFiles.push(filename);
    summaries.push({ label, filename, ...summary.stats });
  };

  if (mergeWaSms) {
    writeBucket('WhatsApp + SMS', 'whatsapp-sms', [buckets.whatsapp, buckets.sms]);
  } else {
    writeBucket('WhatsApp', 'whatsapp', [buckets.whatsapp]);
    writeBucket('SMS', 'sms', [buckets.sms]);
  }
  writeBucket('Email', 'email', [buckets.email]);
  writeBucket('Overig', 'overig', [buckets.overig]);

  // Console-eindrapport.
  console.log('\n================= SAMENVATTING =================');
  if (!writtenFiles.length) {
    console.log('Geen conversaties met inhoud gevonden — geen bestanden geschreven.');
  }
  for (const s of summaries) {
    console.log(`\n▶ ${s.label}  →  ${s.filename}`);
    console.log(`   Conversaties : ${s.convCount}`);
    console.log(`   Berichten    : ${s.msgCount}  (KLANT=${s.n.KLANT}, IK=${s.n.IK}, BOT=${s.n.BOT})`);
    console.log(`   Gem. lengte  : KLANT=${s.avg.KLANT}, IK=${s.avg.IK}, BOT=${s.avg.BOT} tekens`);
    console.log(`   Datum-range  : ${s.range}`);
  }
  console.log('\n▶ Template-detectie');
  console.log(`   IK vóór filtering        : ${ikBefore}`);
  console.log(`   Als template → BOT       : ${templateReclassified}`);
  console.log(`   Echte IK na filtering    : ${ikAfter}`);
  console.log(`   Bekende templates        : ${knownSorted.length} soorten`);
  console.log(`   Frequentie-templates     : ${freqSorted.length} soorten`);
  console.log(`   Rapport                  : ${templateFile}`);
  console.log('\n[export] klaar.');
}

function mergeBuckets(list) {
  const out = { convs: [], roles: { KLANT: [], IK: [], BOT: [] }, msgCount: 0, dates: [] };
  for (const b of list) {
    out.convs.push(...b.convs);
    out.msgCount += b.msgCount;
    out.dates.push(...b.dates);
    out.roles.KLANT.push(...b.roles.KLANT);
    out.roles.IK.push(...b.roles.IK);
    out.roles.BOT.push(...b.roles.BOT);
  }
  return out;
}

function buildSummary(label, bucket) {
  const n = {
    KLANT: bucket.roles.KLANT.length,
    IK: bucket.roles.IK.length,
    BOT: bucket.roles.BOT.length,
  };
  const av = {
    KLANT: avg(bucket.roles.KLANT),
    IK: avg(bucket.roles.IK),
    BOT: avg(bucket.roles.BOT),
  };
  let range = '(geen datums)';
  if (bucket.dates.length) {
    const min = Math.min(...bucket.dates);
    const max = Math.max(...bucket.dates);
    range = `${fmtDate(min)} t/m ${fmtDate(max)}`;
  }
  const text = [
    `SAMENVATTING — ${label}`,
    `Conversaties: ${bucket.convs.length}`,
    `Berichten: ${bucket.msgCount} (KLANT=${n.KLANT}, IK=${n.IK}, BOT=${n.BOT})`,
    `Gemiddelde berichtlengte (tekens): KLANT=${av.KLANT}, IK=${av.IK}, BOT=${av.BOT}`,
    `Datum-range: ${range}`,
  ].join('\n');
  return { text, stats: { convCount: bucket.convs.length, msgCount: bucket.msgCount, n, avg: av, range } };
}

main().catch((err) => {
  console.error('[export-ghl-conversations] failed:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
