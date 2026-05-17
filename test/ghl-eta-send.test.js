import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { sendGeplandeAankomstEtaToContact } from '../lib/ghl-eta-send.js';

describe('sendGeplandeAankomstEtaToContact GHL calls', () => {
  let origKey;
  let requests;

  beforeEach(() => {
    origKey = process.env.GHL_API_KEY;
    process.env.GHL_API_KEY = 'test-key';
    requests = [];
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.GHL_API_KEY;
    else process.env.GHL_API_KEY = origKey;
  });

  it('PUT contact bevat alleen customFields, geen tags-array', async () => {
    const fetchFn = async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const out = await sendGeplandeAankomstEtaToContact({
      apiKey: 'test-key',
      contactId: 'contact-1',
      etaStr: '10:45',
      geplandeAankomstFieldId: 'field-eta',
      fetchFn,
    });
    assert.equal(out.ok, true);
    const put = requests.find((r) => r.method === 'PUT' && r.url.includes('/contacts/contact-1'));
    assert.ok(put);
    const body = JSON.parse(put.body);
    assert.ok(Array.isArray(body.customFields));
    assert.equal(body.customFields[0].field_value, '10:45');
    assert.equal(body.tags, undefined);
    const tagPost = requests.find((r) => r.method === 'POST' && r.url.includes('/tags'));
    assert.ok(tagPost);
    const tagBody = JSON.parse(tagPost.body);
    assert.deepEqual(tagBody.tags, ['monteur-eta']);
    const tagDelete = requests.find((r) => r.method === 'DELETE');
    assert.equal(tagDelete, undefined);
  });
});
