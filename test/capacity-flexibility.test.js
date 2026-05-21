import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BLOCK_REASON,
  evaluateBlockOffer,
  blockOfferKey,
} from '../lib/block-capacity-offers.js';
import { customerMaxForBlock } from '../lib/booking-blocks.js';
import { reservationToSyntheticCalendarEvent } from '../lib/block-reservation-store.js';
import { proposalConstraintsPassCandidate } from '../lib/proposal-constraints.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function morningPendingEvents(count, dateStr = '2026-05-20') {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      reservationToSyntheticCalendarEvent({
        id: `p${i}`,
        contactId: `c-p${i}`,
        dateStr,
        block: 'morning',
        workType: 'onderhoud',
        status: 'pending',
        createdAt: i,
      })
    );
  }
  return out;
}

test('evaluateBlockOffer with enforceCapacity false stays eligible at block max', () => {
  const max = customerMaxForBlock('morning');
  const events = morningPendingEvents(max);
  const strict = evaluateBlockOffer({
    dateStr: '2026-05-20',
    block: 'morning',
    workType: 'onderhoud',
    events,
    dayBlocked: false,
  });
  assert.equal(strict.eligible, false);
  assert.equal(strict.reason, BLOCK_REASON.BLOCK_CAPACITY);

  const bypass = evaluateBlockOffer({
    dateStr: '2026-05-20',
    block: 'morning',
    workType: 'onderhoud',
    events,
    dayBlocked: false,
    options: { enforceCapacity: false },
  });
  assert.equal(bypass.eligible, true);
  assert.equal(bypass.reason, undefined);
});

test('evaluateBlockOffer still rejects day_blocked when enforceCapacity false', () => {
  const bypass = evaluateBlockOffer({
    dateStr: '2026-05-20',
    block: 'morning',
    workType: 'onderhoud',
    events: [],
    dayBlocked: true,
    options: { enforceCapacity: false },
  });
  assert.equal(bypass.eligible, false);
  assert.equal(bypass.reason, BLOCK_REASON.DAY_BLOCKED);
});

test('pending synthetics count toward strict block capacity (same as invite active list)', () => {
  const max = customerMaxForBlock('morning');
  const events = morningPendingEvents(max);
  const evaluation = evaluateBlockOffer({
    dateStr: '2026-05-20',
    block: 'morning',
    workType: 'onderhoud',
    events,
    dayBlocked: false,
  });
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.state.blockCustomerCount, max);
});

test('suggest-slots loads active Redis synthetics for capacity', () => {
  const src = readFileSync(join(root, 'api/suggest-slots.js'), 'utf8');
  assert.match(src, /cachedListActiveSyntheticEventsForDate/);
  assert.doesNotMatch(src, /cachedListConfirmedSyntheticEventsForDate/);
});

test('excludedOfferKeys filters candidate date+block pairs', () => {
  const key = blockOfferKey('2026-05-21', 'morning');
  const constraints = { excludedOfferKeys: [key] };
  assert.equal(proposalConstraintsPassCandidate('2026-05-21', 'morning', constraints), false);
  assert.equal(proposalConstraintsPassCandidate('2026-05-21', 'afternoon', constraints), true);
  assert.equal(proposalConstraintsPassCandidate('2026-05-22', 'morning', constraints), true);
});
