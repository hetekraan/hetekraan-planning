#!/usr/bin/env node

const apiKey = String(process.env.GHL_API_KEY || '').trim();
const locationId = String(process.env.GHL_LOCATION_ID || '').trim();

if (!apiKey || !locationId) {
  console.error('Missing env: GHL_API_KEY and/or GHL_LOCATION_ID');
  process.exit(1);
}

const base = 'https://services.leadconnectorhq.com';
const url = `${base}/locations/${encodeURIComponent(locationId)}/customFields`;

const res = await fetch(url, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    Accept: 'application/json',
  },
});

const text = await res.text();
let json = {};
try {
  json = JSON.parse(text);
} catch {
  // ignore parse failure, handled below
}

if (!res.ok) {
  console.error(`GHL request failed: ${res.status}`);
  console.error((text || '').slice(0, 500));
  process.exit(1);
}

const rows = json.customFields || json.fields || json.data || [];
if (!Array.isArray(rows) || rows.length === 0) {
  console.log('No custom fields returned.');
  process.exit(0);
}

for (const f of rows) {
  const name = String(f?.name || f?.fieldName || '(no name)');
  const id = String(f?.id || f?._id || '(no id)');
  console.log(`${name}\t${id}`);
}
