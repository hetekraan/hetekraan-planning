import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeoValid } from '../lib/geo-gate.js';

const COORDS = {
  zaandam: { lat: 52.4397, lng: 4.8136 },
  denHelder: { lat: 52.9563, lng: 4.7601 },
  alkmaar: { lat: 52.6324, lng: 4.7534 },
  heerhugowaard: { lat: 52.6603, lng: 4.8358 },
  haarlem: { lat: 52.3874, lng: 4.6462 },
  hoorn: { lat: 52.6424, lng: 5.0601 },
  zandvoort: { lat: 52.3714, lng: 4.5342 },
};

function ctx({ morning = [], afternoon = [], targetBlock = 'morning' } = {}) {
  return { morning, afternoon, targetBlock };
}

test('geo-gate: lege dag, Zaandam dicht bij depot => valid', () => {
  const out = isGeoValid(COORDS.zaandam, ctx({}));
  assert.equal(out.valid, true);
  assert.equal(out.reason, 'ok');
});

test('geo-gate: lege dag, Den Helder te ver van depot => invalid depot-too-far', () => {
  const out = isGeoValid(COORDS.denHelder, ctx({}));
  assert.equal(out.valid, false);
  assert.equal(out.reason, 'depot-too-far');
});

test('geo-gate: ochtend rond Alkmaar, Heerhugowaard dichtbij => valid', () => {
  const out = isGeoValid(
    COORDS.heerhugowaard,
    ctx({ morning: [COORDS.alkmaar], targetBlock: 'morning' })
  );
  assert.equal(out.valid, true);
  assert.equal(out.reason, 'ok');
});

test('geo-gate: ochtend rond Alkmaar, Haarlem buiten blokradius => invalid block-centroid-exceeded', () => {
  const out = isGeoValid(COORDS.haarlem, ctx({ morning: [COORDS.alkmaar], targetBlock: 'morning' }));
  assert.equal(out.valid, false);
  assert.equal(out.reason, 'block-centroid-exceeded');
});

test('geo-gate: ochtend Alkmaar, middag leeg, nieuwe middag Hoorn => valid transition', () => {
  const out = isGeoValid(COORDS.hoorn, ctx({ morning: [COORDS.alkmaar], targetBlock: 'afternoon' }));
  assert.equal(out.valid, true);
  assert.equal(out.reason, 'ok');
});

test('geo-gate: ochtend Alkmaar, middag leeg, nieuwe middag Zandvoort => invalid transition-too-far', () => {
  const out = isGeoValid(COORDS.zandvoort, ctx({ morning: [COORDS.alkmaar], targetBlock: 'afternoon' }));
  assert.equal(out.valid, false);
  assert.equal(out.reason, 'transition-too-far');
});

test('geo-gate: null coord => altijd valid no-coord-skip', () => {
  const out = isGeoValid(null, ctx({ morning: [COORDS.alkmaar], targetBlock: 'morning' }));
  assert.equal(out.valid, true);
  assert.equal(out.reason, 'no-coord-skip');
});
