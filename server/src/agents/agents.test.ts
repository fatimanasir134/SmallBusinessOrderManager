import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_INFO } from '@sbom/shared';
import * as communication from './communication.js';
import { moneyAmounts, unverifiedAmounts } from './communication.js';
import * as inventory from './inventory.js';
import * as orderManagement from './orderManagement.js';
import * as pricing from './pricing.js';
import * as production from './production.js';
import * as understanding from './understanding.js';
import { compareClaims, sameLines, verificationOf } from './runtime.js';

describe('communication money check', () => {
  it('reads dollar amounts in common formats', () => {
    assert.deepEqual(moneyAmounts('Total $12.82, was $13 or $ 1,250.50'), [1282, 1300, 125050]);
  });
  it('flags amounts that are not in the verified facts', () => {
    const facts = { quote: { total: '$12.82', subtotal: '$13.50' } };
    assert.deepEqual(unverifiedAmounts('Your total is $12.82 (from $13.50).', facts), []);
    assert.deepEqual(unverifiedAmounts('Special price: $9.99!', facts), [999]);
  });
});

describe('agent verification helpers', () => {
  it('compares order lines regardless of order and duplicates', () => {
    const expected = [
      { productId: 1, quantity: 3 },
      { productId: 2, quantity: 1 },
    ];
    assert.equal(
      sameLines(
        [
          { productId: 2, quantity: 1 },
          { productId: 1, quantity: 2 },
          { productId: 1, quantity: 1 },
        ],
        expected,
      ),
      true,
    );
    assert.equal(sameLines([{ productId: 1, quantity: 1 }], expected), false);
    assert.equal(sameLines('nonsense', expected), false);
  });
  it('lists claims that disagree with the tools', () => {
    assert.deepEqual(compareClaims({ totalCents: 850, extra: 1 }, { totalCents: 1282 }), [
      'totalCents: agent said 850, tools say 1282',
    ]);
  });
  it('classifies verification', () => {
    assert.equal(verificationOf(false, []), 'matched');
    assert.equal(verificationOf(false, ['x']), 'corrected');
    assert.equal(verificationOf(true, []), 'recomputed');
  });
});

describe('agent metadata shown in the UI', () => {
  it('lists exactly the tools each agent is given', () => {
    const real = {
      understanding,
      pricing,
      inventory,
      production,
      communication,
      order_management: orderManagement,
    };
    for (const [name, mod] of Object.entries(real)) {
      assert.deepEqual(
        [...AGENT_INFO[name as keyof typeof AGENT_INFO].tools],
        [...mod.TOOLS],
        name,
      );
    }
  });
});
