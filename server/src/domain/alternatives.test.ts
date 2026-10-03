import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRODUCTS, RULES, product } from '../test/fixtures.js';
import { deadlineAlternatives, discountOpportunities, findSubstitutes } from './alternatives.js';
import { assessInventory } from './inventory.js';
import { calculatePrice, type PricingInput } from './pricing.js';

const TODAY = '2026-10-01';

function priced(sku: string, quantity: number, tier: PricingInput['customerTier'] = 'standard') {
  const p = product(sku);
  const input: PricingInput = {
    lines: [{ productId: p.id, quantity, unitPriceCents: p.unitPriceCents }],
    rules: RULES,
    customerTier: tier,
    requestedDeadline: null,
    today: TODAY,
    discountRequested: true,
  };
  return { input, quote: calculatePrice(input) };
}

describe('discountOpportunities', () => {
  it('finds the next volume tier with what it would cost', () => {
    const { input, quote } = priced('STK-HOLO', 2); // $13.00, no discount
    const [o] = discountOpportunities(input, quote);
    assert.equal(o!.addUnits, 1);
    assert.equal(o!.newQuantity, 3);
    assert.equal(o!.ruleName, 'Volume 3+');
    assert.equal(o!.newTotalCents, 1852); // 3 x 650 = 1950, -5% (97.5 rounds to 98)
    assert.equal(o!.extraCostCents, 1852 - 1300);
  });

  it('suggests nothing when the next tier is far away or the discount is already capped', () => {
    const { input, quote } = priced('BKMK-FLORAL', 30); // already at the top tier
    assert.deepEqual(discountOpportunities(input, quote), []);
    const capped = priced('CARD-THANK', 10, 'wholesale'); // 27% capped to 20%: more units gain nothing
    assert.deepEqual(discountOpportunities(capped.input, capped.quote), []);
  });
});

describe('findSubstitutes', () => {
  it('offers same-category products we can supply, closest in price', () => {
    const washi = product('WASHI-PASTEL');
    const stock = assessInventory([{ productId: washi.id, quantity: 2 }], PRODUCTS);
    // Washi is the only "tape": no substitutes.
    assert.deepEqual(findSubstitutes(stock.lines, PRODUCTS), []);

    const catalogue = [
      ...PRODUCTS,
      {
        ...washi,
        id: 99,
        sku: 'WASHI-GOLD',
        name: 'Gold washi tape',
        unitPriceCents: 1000,
        inventory: { ...washi.inventory, available: 10 },
      },
    ];
    const subs = findSubstitutes(stock.lines, catalogue);
    assert.deepEqual(
      subs.map((s) => s.sku),
      ['WASHI-GOLD'],
    );
  });
});

describe('deadlineAlternatives', () => {
  it('offers a later date, the quantity that fits, and a split delivery', () => {
    const pink = product('STK-PINK'); // 2 in stock, 20 min per unit
    const stock = assessInventory([{ productId: pink.id, quantity: 10 }], PRODUCTS); // 2 + 8 to make
    const alts = deadlineAlternatives({
      stock,
      minutesPerUnit: new Map(PRODUCTS.map((p) => [p.id, p.productionMinutesPerUnit])),
      freeMinutesByDeadline: 100, // 5 more units by the deadline
      earliestPossibleDate: '2026-10-05',
      today: TODAY,
      deadline: '2026-10-02',
    });
    assert.deepEqual(
      alts.map((a) => a.type),
      ['later_date', 'reduced_quantity', 'split_delivery'],
    );
    const reduced = alts.find((a) => a.type === 'reduced_quantity');
    assert.equal(reduced?.type === 'reduced_quantity' && reduced.quantity, 7);
  });

  it('skips options that would not help', () => {
    const custom = product('STK-CUSTOM'); // made to order, nothing in stock
    const stock = assessInventory([{ productId: custom.id, quantity: 3 }], PRODUCTS);
    const alts = deadlineAlternatives({
      stock,
      minutesPerUnit: new Map(PRODUCTS.map((p) => [p.id, p.productionMinutesPerUnit])),
      freeMinutesByDeadline: 0,
      earliestPossibleDate: '2026-10-03',
      today: TODAY,
      deadline: '2026-10-01',
    });
    assert.deepEqual(
      alts.map((a) => a.type),
      ['later_date'],
    );
  });
});
