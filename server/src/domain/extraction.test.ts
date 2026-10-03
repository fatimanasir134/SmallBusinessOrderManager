import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRODUCTS } from '../test/fixtures.js';
import { type RawExtraction, normalizeExtraction } from './extraction.js';

const TODAY = '2026-10-01'; // Thursday

const raw = (r: Partial<RawExtraction>): RawExtraction => ({
  customer: { name: null, email: null, phone: null },
  items: [],
  deadlineText: null,
  deadlineDate: null,
  discountRequested: false,
  customization: null,
  otherRequests: null,
  ...r,
});

describe('normalizeExtraction', () => {
  it('demo message: resolves product, quantity, Friday deadline, and discount request', () => {
    const e = normalizeExtraction(
      raw({
        items: [{ productQuery: 'Pink sticker sheet', quantity: 3 }],
        deadlineText: 'by Friday',
        deadlineDate: '2026-10-09', // model got it wrong; our parser wins
        discountRequested: true,
      }),
      PRODUCTS,
      TODAY,
    );
    assert.equal(e.isComplete, true);
    assert.deepEqual(
      e.items.map((i) => [i.sku, i.quantity]),
      [['STK-PINK', 3]],
    );
    assert.equal(e.requestedDeadline, '2026-10-02');
    assert.equal(e.deadlineSource, 'parsed');
    assert.equal(e.discountRequested, true);
    assert.deepEqual(e.missingInfo, []);
  });

  it("falls back to the model's date when the phrase isn't understood", () => {
    const e = normalizeExtraction(
      raw({
        items: [{ productQuery: 'floral bookmark', quantity: 1 }],
        deadlineText: "for my sister's party",
        deadlineDate: '2026-10-10',
      }),
      PRODUCTS,
      TODAY,
    );
    assert.equal(e.requestedDeadline, '2026-10-10');
    assert.equal(e.deadlineSource, 'model');
  });

  it('rejects past or invalid deadlines and asks for a date instead', () => {
    const past = normalizeExtraction(
      raw({ items: [{ productQuery: 'holo', quantity: 1 }], deadlineDate: '2026-09-01' }),
      PRODUCTS,
      TODAY,
    );
    assert.equal(past.requestedDeadline, null);
    assert.match(past.missingInfo.join(' '), /in the past/);

    const invalid = normalizeExtraction(
      raw({
        items: [{ productQuery: 'holo', quantity: 1 }],
        deadlineText: 'soonish',
        deadlineDate: '2026-13-45',
      }),
      PRODUCTS,
      TODAY,
    );
    assert.equal(invalid.requestedDeadline, null);
    assert.deepEqual(invalid.missingInfo, [], 'a vague deadline does not pause the order');
  });

  it('asks for the quantity when it is missing', () => {
    const e = normalizeExtraction(
      raw({ items: [{ productQuery: 'washi tape', quantity: null }] }),
      PRODUCTS,
      TODAY,
    );
    assert.equal(e.isComplete, false);
    assert.equal(e.unresolvedItems[0]!.reason, 'missing_quantity');
    assert.match(e.missingInfo[0]!, /How many Pastel washi tape set/);
  });

  it('rejects zero, negative, fractional, and huge quantities', () => {
    for (const quantity of [0, -2, 1.5, 5000]) {
      const e = normalizeExtraction(
        raw({ items: [{ productQuery: 'holo', quantity }] }),
        PRODUCTS,
        TODAY,
      );
      assert.equal(e.unresolvedItems[0]!.reason, 'invalid_quantity', `quantity ${quantity}`);
      assert.equal(e.items.length, 0);
    }
  });

  it('flags ambiguous and unknown products with candidates', () => {
    const e = normalizeExtraction(
      raw({
        items: [
          { productQuery: 'stickers', quantity: 2 },
          { productQuery: 'unicorn mug', quantity: 1 },
        ],
      }),
      PRODUCTS,
      TODAY,
    );
    assert.deepEqual(
      e.unresolvedItems.map((u) => u.reason),
      ['ambiguous_product', 'unknown_product'],
    );
    assert.ok(e.unresolvedItems[0]!.candidates.length >= 2);
    assert.equal(e.isComplete, false);
  });

  it('merges repeated mentions of the same product', () => {
    const e = normalizeExtraction(
      raw({
        items: [
          { productQuery: 'pink sticker sheets', quantity: 2 },
          { productQuery: 'STK-PINK', quantity: 1 },
        ],
      }),
      PRODUCTS,
      TODAY,
    );
    assert.equal(e.items.length, 1);
    assert.equal(e.items[0]!.quantity, 3);
  });

  it('asks what they want when no items were found', () => {
    const e = normalizeExtraction(raw({}), PRODUCTS, TODAY);
    assert.equal(e.isComplete, false);
    assert.match(e.missingInfo[0]!, /Which products/);
  });
});
