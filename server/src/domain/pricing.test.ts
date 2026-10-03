import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CustomerTier } from '@sbom/shared';
import { PRODUCTS, RULES, product } from '../test/fixtures.js';
import { calculatePrice } from './pricing.js';

const TODAY = '2026-10-01';

function quote(
  items: [sku: string, qty: number][],
  opts: { tier?: CustomerTier; deadline?: string; discountRequested?: boolean } = {},
) {
  return calculatePrice({
    lines: items.map(([sku, quantity]) => {
      const p = product(sku);
      return { productId: p.id, quantity, unitPriceCents: p.unitPriceCents };
    }),
    rules: RULES,
    customerTier: opts.tier ?? null,
    requestedDeadline: opts.deadline ?? null,
    today: TODAY,
    discountRequested: opts.discountRequested,
  });
}

describe('calculatePrice', () => {
  it('demo order: 3 pink sheets get the 3+ volume discount', () => {
    const q = quote([['STK-PINK', 3]], { deadline: '2026-10-09' });
    assert.equal(q.subtotalCents, 1350);
    assert.equal(q.discountCents, 68); // 5% of 1350 = 67.5, rounded
    assert.equal(q.totalCents, 1282);
    assert.equal(q.surchargeCents, 0);
    assert.deepEqual(
      q.appliedRules.map((r) => r.name),
      ['Volume 3+'],
    );
  });

  it('charges full price below the first volume threshold', () => {
    const q = quote([['STK-HOLO', 2]]);
    assert.equal(q.totalCents, 1300);
    assert.equal(q.discountCents, 0);
    assert.equal(q.appliedRules.length, 0);
  });

  it('explains when a requested discount does not apply', () => {
    const q = quote([['STK-HOLO', 2]], { discountRequested: true });
    assert.match(q.notes.join(' '), /no pricing rule applies.*5% off starts at 3 units/);
  });

  it('uses only the best volume rule, not the sum of all thresholds met', () => {
    const q = quote([['BKMK-FLORAL', 30]]);
    assert.equal(q.lines[0]!.discountPercent, 15);
    assert.equal(q.totalCents, 30 * 350 * 0.85);
  });

  it('stacks the tier discount on the volume discount (loyal: 5% + 5%)', () => {
    const q = quote([['BKMK-FLORAL', 6]], { tier: 'loyal' });
    assert.equal(q.totalCents, 1890);
    assert.equal(q.discountPercent, 10);
  });

  it('prefers a better product-specific rule and caps the combined discount at 20%', () => {
    // Card bundle 12% beats Volume 10+ (10%); + wholesale 15% = 27%, capped to 20%.
    const q = quote([['CARD-THANK', 10]], { tier: 'wholesale' });
    const line = q.lines[0]!;
    assert.equal(line.discountPercent, 20);
    assert.equal(line.capped, true);
    assert.deepEqual(
      line.appliedRules.map((r) => r.name),
      ['Card bundle', 'Wholesale'],
    );
    assert.equal(q.totalCents, 6400);
    assert.match(q.notes.join(' '), /capped at the 20% maximum/);
  });

  it('prices each line separately in a multi-item order', () => {
    const q = quote([
      ['STK-PINK', 1],
      ['STK-HOLO', 4],
    ]);
    assert.equal(q.lines[0]!.discountPercent, 0);
    assert.equal(q.lines[1]!.discountPercent, 5);
    assert.equal(q.subtotalCents, 450 + 2600);
    assert.equal(q.totalCents, 450 + 2600 - 130);
  });

  it('adds the rush surcharge on the discounted subtotal when the deadline is within 2 days', () => {
    const q = quote([['STK-PINK', 3]], { deadline: '2026-10-02' });
    assert.equal(q.surchargePercent, 20);
    assert.equal(q.surchargeCents, 256); // 20% of 1282 = 256.4
    assert.equal(q.totalCents, 1282 + 256);
  });

  it('applies rush at exactly 2 days but not at 3', () => {
    assert.equal(quote([['STK-PINK', 1]], { deadline: '2026-10-03' }).surchargePercent, 20);
    assert.equal(quote([['STK-PINK', 1]], { deadline: '2026-10-04' }).surchargePercent, 0);
  });

  it('ignores inactive rules', () => {
    const q = calculatePrice({
      lines: [{ productId: PRODUCTS[0]!.id, quantity: 3, unitPriceCents: 450 }],
      rules: RULES.map((r) => ({ ...r, active: r.ruleType !== 'volume_discount' })),
      customerTier: null,
      requestedDeadline: null,
      today: TODAY,
    });
    assert.equal(q.discountCents, 0);
  });

  it('works with no rules at all', () => {
    const q = calculatePrice({
      lines: [{ productId: 1, quantity: 2, unitPriceCents: 999 }],
      rules: [],
      customerTier: 'wholesale',
      requestedDeadline: TODAY,
      today: TODAY,
    });
    assert.equal(q.totalCents, 1998);
    assert.equal(q.maxDiscountPercent, null);
  });
});
