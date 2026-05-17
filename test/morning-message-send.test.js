import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMorningMessagesBatch,
  resetMorningMessageSendWarningsForTests,
} from '../lib/morning-message-send.js';

test('sendMorningMessagesBatch writes both fields when venster id is provided', async () => {
  resetMorningMessageSendWarningsForTests();
  const bodies = [];
  const contactBodies = [];
  const fetchFn = async (url, init) => {
    const method = String(init?.method || 'GET').toUpperCase();
    if (method === 'PUT' && String(url).includes('/contacts/c1') && !String(url).includes('/tags')) {
      contactBodies.push(JSON.parse(String(init.body)));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const origFetch = global.fetch;
  const origKey = process.env.GHL_API_KEY;
  global.fetch = fetchFn;
  process.env.GHL_API_KEY = 'test-key';

  try {
    const out = await sendMorningMessagesBatch(
      [
        {
          contactId: 'c1',
          plannedValue: '10:30',
          windowPhrase: 'tussen 09:30 en 11:30',
        },
      ],
      {
        apiKey: 'test-key',
        geplandeAankomstFieldId: 'field-start',
        geplandeAankomstVensterFieldId: 'field-venster',
        fetchFn,
      }
    );
    assert.equal(out.sent, 1);
    assert.equal(contactBodies.length, 1);
    assert.equal(contactBodies[0].customFields.length, 2);
    assert.equal(contactBodies[0].customFields[0].field_value, '10:30');
    assert.equal(contactBodies[0].customFields[1].field_value, 'tussen 09:30 en 11:30');
  } finally {
    global.fetch = origFetch;
    if (origKey === undefined) delete process.env.GHL_API_KEY;
    else process.env.GHL_API_KEY = origKey;
  }
});

test('sendMorningMessagesBatch skips venster field when id missing', async () => {
  resetMorningMessageSendWarningsForTests();
  const contactBodies = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const fetchFn = async (url, init) => {
    const method = String(init?.method || 'GET').toUpperCase();
    if (method === 'PUT' && String(url).includes('/contacts/c1') && !String(url).includes('/tags')) {
      contactBodies.push(JSON.parse(String(init.body)));
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const origFetch = global.fetch;
  const origKey = process.env.GHL_API_KEY;
  global.fetch = fetchFn;
  process.env.GHL_API_KEY = 'test-key';

  try {
    const out = await sendMorningMessagesBatch(
      [{ contactId: 'c1', plannedValue: '09:00', windowPhrase: 'om 09:00' }],
      {
        apiKey: 'test-key',
        geplandeAankomstFieldId: 'field-start',
        geplandeAankomstVensterFieldId: null,
        fetchFn,
      }
    );
    assert.equal(out.sent, 1);
    assert.equal(contactBodies[0].customFields.length, 1);
    assert.ok(warnings.some((w) => w.includes('geplande_aankomst_venster')));
  } finally {
    console.warn = origWarn;
    global.fetch = origFetch;
    if (origKey === undefined) delete process.env.GHL_API_KEY;
    else process.env.GHL_API_KEY = origKey;
  }
});
