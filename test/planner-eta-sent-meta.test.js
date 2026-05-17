import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildEtaSentMetaBucket,
  getEtaSentMetaForContactFromRouteState,
  getEtaSentMetaFromBucket,
  patchRouteStateEtaSent,
} from '../public/app/planner-eta-sent-meta-core.mjs';

describe('planner eta-sent meta (day-scoped)', () => {
  it('returns meta only when route state for that day has etaSentByContactId', () => {
    const states = new Map([
      [
        '2026-05-10',
        {
          etaSentByContactId: {
            contactY: { eta: '09:30', sentAt: 1000 },
          },
        },
      ],
      ['2026-05-11', { etaSentByContactId: {} }],
    ]);
    const getState = (ds) => states.get(ds) || null;

    const onDayX = getEtaSentMetaForContactFromRouteState('contactY', '2026-05-10', getState);
    assert.ok(onDayX);
    assert.equal(onDayX.eta, '09:30');
    assert.equal(onDayX.sentAt, 1000);

    const onDayNext = getEtaSentMetaForContactFromRouteState('contactY', '2026-05-11', getState);
    assert.equal(onDayNext, null);
  });

  it('does not leak eta meta across days via bucket builder', () => {
    const dayX = buildEtaSentMetaBucket({
      etaSentByContactId: { c1: { eta: '10:00', sentAt: 1 } },
    });
    const dayNext = buildEtaSentMetaBucket({ etaSentByContactId: {} });
    assert.ok(getEtaSentMetaFromBucket(dayX, 'c1'));
    assert.equal(getEtaSentMetaFromBucket(dayNext, 'c1'), null);
  });

  it('patchRouteStateEtaSent only updates provided route state object', () => {
    const patched = patchRouteStateEtaSent(
      { dateStr: '2026-05-10', etaSentByContactId: {} },
      'c2',
      '11:15',
      2000
    );
    assert.equal(patched.etaSentByContactId.c2.eta, '11:15');
    assert.equal(patched.etaSentByContactId.c2.sentAt, 2000);
  });
});
