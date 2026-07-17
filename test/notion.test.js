import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapBronToNotion,
  mapTypeWerkToNotion,
  normalizeNotionPhone,
  upsertKlantInNotion,
  createKlusInNotion,
  appendNotionPlannerNote,
  parseNotionPlannerNote,
  NOTION_KLANT_PROPS,
  NOTION_KLUS_PROPS,
} from '../lib/notion.js';

function setEnv() {
  process.env.NOTION_TOKEN = 'secret_test';
  process.env.NOTION_DB_KLANTEN = 'db-klanten';
  process.env.NOTION_DB_KLUSSEN = 'db-klussen';
}

/** Bouwt een mock-fetch die opeenvolgende requests logt en gescripte responses teruggeeft. */
function makeFetch(handlers) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });
    const handler = handlers(url, method, body, calls.length - 1);
    const status = handler?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => handler?.data ?? {},
    };
  };
  return { fetch, calls };
}

test('mapBronToNotion mapt varianten en default Onbekend', () => {
  assert.equal(mapBronToNotion('Facebook Ads'), 'Facebook');
  assert.equal(mapBronToNotion('fb'), 'Facebook');
  assert.equal(mapBronToNotion('meta'), 'Facebook');
  assert.equal(mapBronToNotion('Google Adwords'), 'Google');
  assert.equal(mapBronToNotion('onze website'), 'Website');
  assert.equal(mapBronToNotion('referral van buurman'), 'Doorverwezen');
  assert.equal(mapBronToNotion('doorverwezen'), 'Doorverwezen');
  assert.equal(mapBronToNotion(''), 'Onbekend');
  assert.equal(mapBronToNotion(null), 'Onbekend');
  assert.equal(mapBronToNotion('iets raars'), 'Onbekend');
});

test('mapTypeWerkToNotion normaliseert naar vaste select-waardes', () => {
  assert.equal(mapTypeWerkToNotion('Herafspraak'), 'Herafspraak');
  assert.equal(mapTypeWerkToNotion('installatie'), 'Installatie');
  assert.equal(mapTypeWerkToNotion('onderhoud'), 'Onderhoud');
  assert.equal(mapTypeWerkToNotion('reparatie'), 'Reparatie');
  assert.equal(mapTypeWerkToNotion(''), 'Reparatie');
});

test('normalizeNotionPhone -> E.164', () => {
  assert.equal(normalizeNotionPhone('0612345678'), '+31612345678');
  assert.equal(normalizeNotionPhone('06-12345678'), '+31612345678');
  assert.equal(normalizeNotionPhone(''), '');
});

// Schema-respons voor de TIJDELIJKE diagnostiek (GET /databases/{id}).
const KLANTEN_SCHEMA = {
  title: [{ plain_text: 'Klanten' }],
  properties: { 'GHL-ID': { type: 'rich_text' }, Telefoon: { type: 'phone_number' }, Naam: { type: 'title' } },
};

function isSchemaGet(url, method) {
  return method === 'GET' && url.endsWith('/databases/db-klanten');
}

test('upsertKlant: nieuwe klant -> query GHL-ID + Telefoon leeg, dan POST create', async () => {
  setEnv();
  const { fetch, calls } = makeFetch((url, method) => {
    if (isSchemaGet(url, method)) return { data: KLANTEN_SCHEMA };
    if (url.endsWith('/databases/db-klanten/query')) return { data: { results: [] } };
    if (url.endsWith('/pages') && method === 'POST') return { data: { id: 'new-klant-1' } };
    return { status: 500, data: { message: 'unexpected' } };
  });
  const out = await upsertKlantInNotion(
    { ghlId: 'ghl-1', telefoon: '0612345678', naam: 'Jan Jansen', email: 'JAN@x.nl', bron: 'facebook' },
    { fetch }
  );
  assert.deepEqual(out, { pageId: 'new-klant-1', created: true });
  // Volgorde: query op GHL-ID, query op Telefoon, dan create.
  const queryCalls = calls.filter((c) => c.url.endsWith('/query'));
  assert.equal(queryCalls[0].body.filter.property, NOTION_KLANT_PROPS.ghlId);
  assert.equal(queryCalls[1].body.filter.property, NOTION_KLANT_PROPS.telefoon);
  assert.equal(queryCalls[1].body.filter.phone_number.equals, '+31612345678');
  const createCall = calls.find((c) => c.url.endsWith('/pages') && c.method === 'POST');
  assert.ok(createCall, 'create-call aanwezig');
  assert.equal(createCall.body.parent.database_id, 'db-klanten');
  assert.equal(createCall.body.properties[NOTION_KLANT_PROPS.bron].select.name, 'Facebook');
});

test('upsertKlant: bestaande klant via GHL-ID -> PATCH update, geen create', async () => {
  setEnv();
  const { fetch, calls } = makeFetch((url, method) => {
    if (isSchemaGet(url, method)) return { data: KLANTEN_SCHEMA };
    if (url.endsWith('/databases/db-klanten/query')) return { data: { results: [{ id: 'klant-existing' }] } };
    if (url.includes('/pages/klant-existing') && method === 'PATCH') return { data: { id: 'klant-existing' } };
    return { status: 500, data: { message: 'unexpected' } };
  });
  const out = await upsertKlantInNotion({ ghlId: 'ghl-1', telefoon: '0612345678', naam: 'Jan' }, { fetch });
  assert.deepEqual(out, { pageId: 'klant-existing', created: false });
  assert.ok(
    calls.some((c) => c.url.includes('/pages/klant-existing') && c.method === 'PATCH'),
    'PATCH update uitgevoerd'
  );
  assert.ok(!calls.some((c) => c.url.endsWith('/pages') && c.method === 'POST'), 'geen POST create');
});

test('upsertKlant: notion_klant_id hint -> direct page-lookup, geen db-query', async () => {
  setEnv();
  const { fetch, calls } = makeFetch((url, method) => {
    if (isSchemaGet(url, method)) return { data: KLANTEN_SCHEMA };
    if (url.includes('/pages/hint-page') && method === 'GET') return { data: { id: 'hint-page', archived: false } };
    if (url.includes('/pages/hint-page') && method === 'PATCH') return { data: { id: 'hint-page' } };
    return { status: 500, data: { message: 'unexpected' } };
  });
  const out = await upsertKlantInNotion(
    { ghlId: 'ghl-1', telefoon: '0612345678', notionKlantId: 'hint-page', naam: 'Jan' },
    { fetch }
  );
  assert.deepEqual(out, { pageId: 'hint-page', created: false });
  assert.ok(!calls.some((c) => c.url.endsWith('/query')), 'geen db-query nodig bij geldige hint');
});

test('createKlus: POST met relation + velden, GEEN Marge property', async () => {
  setEnv();
  const { fetch, calls } = makeFetch((url, method) => {
    if (url.endsWith('/pages') && method === 'POST') {
      return { data: { id: 'klus-1', url: 'https://notion.so/klus-1' } };
    }
    return { status: 500, data: { message: 'unexpected' } };
  });
  const out = await createKlusInNotion(
    {
      titel: 'Onderhoud - Jan',
      datum: '2026-07-17',
      typeWerk: 'onderhoud',
      omzet: 123.45,
      materiaalkosten: 20,
      status: 'Afgerond',
      plannerLink: 'https://planner/x',
    },
    'klant-1',
    { fetch }
  );
  assert.deepEqual(out, { pageId: 'klus-1', url: 'https://notion.so/klus-1' });
  const props = calls[0].body.properties;
  assert.deepEqual(props[NOTION_KLUS_PROPS.klant].relation, [{ id: 'klant-1' }]);
  assert.equal(props[NOTION_KLUS_PROPS.omzet].number, 123.45);
  assert.equal(props[NOTION_KLUS_PROPS.materiaalkosten].number, 20);
  assert.equal(props[NOTION_KLUS_PROPS.status].select.name, 'Afgerond');
  assert.equal(props[NOTION_KLUS_PROPS.typeWerk].select.name, 'Onderhoud');
  assert.equal(props[NOTION_KLUS_PROPS.datum].date.start, '2026-07-17');
  assert.ok(!('Marge' in props), 'Marge (formule) mag niet geschreven worden');
});

test('createKlus: zonder materiaalkosten -> number null (geen crash, marge=omzet in Notion)', async () => {
  setEnv();
  const { fetch, calls } = makeFetch((url, method) => {
    if (url.endsWith('/pages') && method === 'POST') return { data: { id: 'klus-2', url: '' } };
    return { status: 500, data: { message: 'unexpected' } };
  });
  const out = await createKlusInNotion(
    { titel: 'Reparatie', datum: '2026-07-17', typeWerk: 'reparatie', omzet: 89, materiaalkosten: undefined },
    'klant-1',
    { fetch }
  );
  assert.equal(out.pageId, 'klus-2');
  assert.equal(calls[0].body.properties[NOTION_KLUS_PROPS.materiaalkosten].number, null);
});

test('planner-marker: append behoudt bestaande [moneybird]-marker, parse leest status/klusId/url', () => {
  const existing = 'Klant belde\n[moneybird] invoiceId=123 reference=hk-appt:9 url=https://moneybird.dev/x';
  const next = appendNotionPlannerNote(existing, {
    status: 'synced',
    klusId: 'klus-1',
    url: 'https://notion.so/klus-1',
  });
  assert.match(next, /\[moneybird\] invoiceId=123/, 'moneybird-marker blijft behouden');
  assert.match(next, /\[notion\] status=synced klusId=klus-1 url=https:\/\/notion\.so\/klus-1/);
  const parsed = parseNotionPlannerNote(next);
  assert.deepEqual(parsed, { status: 'synced', klusId: 'klus-1', url: 'https://notion.so/klus-1' });
});

test('planner-marker: append vervangt oude [notion]-marker (geen dubbele)', () => {
  const first = appendNotionPlannerNote('Basis', { status: 'error' });
  const second = appendNotionPlannerNote(first, { status: 'synced', klusId: 'k2' });
  assert.equal((second.match(/\[notion\]/g) || []).length, 1);
  assert.equal(parseNotionPlannerNote(second).status, 'synced');
});

test('planner-marker: parse zonder marker -> null', () => {
  assert.equal(parseNotionPlannerNote('geen marker hier'), null);
});

test('notion-fout: niet-2xx gooit Error met status/code', async () => {
  setEnv();
  const { fetch } = makeFetch(() => ({ status: 401, data: { code: 'unauthorized', message: 'API token is invalid.' } }));
  await assert.rejects(
    () => upsertKlantInNotion({ ghlId: 'ghl-1', telefoon: '0612345678', naam: 'Jan' }, { fetch }),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      return true;
    }
  );
});
