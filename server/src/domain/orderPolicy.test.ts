import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkTransition } from './orderPolicy.js';

describe('checkTransition (human-in-the-loop policy)', () => {
  it('lets agents move orders through analysis', () => {
    assert.deepEqual(checkTransition('received', 'processing', 'agent'), { ok: true });
    assert.deepEqual(checkTransition('processing', 'awaiting_approval', 'agent'), { ok: true });
    assert.deepEqual(checkTransition('processing', 'needs_info', 'agent'), { ok: true });
  });

  it('never lets an agent or the system approve, reject, or cancel', () => {
    for (const actor of ['agent', 'system'] as const) {
      for (const to of ['confirmed', 'rejected', 'cancelled'] as const) {
        const r = checkTransition('awaiting_approval', to, actor);
        assert.equal(r.ok, false, `${actor} -> ${to}`);
        assert.equal(!r.ok && r.code, 'FORBIDDEN');
      }
    }
  });

  it('lets a human approve', () => {
    assert.deepEqual(checkTransition('awaiting_approval', 'confirmed', 'human'), { ok: true });
  });

  it('blocks transitions the workflow does not allow, even for humans', () => {
    const r = checkTransition('received', 'confirmed', 'human');
    assert.equal(!r.ok && r.code, 'INVALID_TRANSITION');
    assert.equal(checkTransition('completed', 'processing', 'human').ok, false);
  });
});
