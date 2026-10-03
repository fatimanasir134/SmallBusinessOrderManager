import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRODUCTS, product } from '../test/fixtures.js';
import { assessInventory, suggestedReorder } from './inventory.js';

const line = (sku: string, quantity: number) => ({ productId: product(sku).id, quantity });

describe('assessInventory', () => {
  it('demo order: 2 of 3 pink sheets ship from stock, 1 must be produced', () => {
    const a = assessInventory([line('STK-PINK', 3)], PRODUCTS);
    const l = a.lines[0]!;
    assert.equal(l.status, 'partial');
    assert.equal(l.fromStock, 2);
    assert.equal(l.toProduce, 1);
    assert.equal(l.productionMinutes, 20);
    assert.equal(l.availableAfter, 0);
    assert.equal(l.belowReorderPointAfter, true);
    assert.equal(a.allInStock, false);
    assert.equal(a.totalProductionMinutes, 20);
  });

  it('fully in stock needs no production', () => {
    const a = assessInventory([line('STK-HOLO', 4)], PRODUCTS);
    assert.equal(a.lines[0]!.status, 'in_stock');
    assert.equal(a.allInStock, true);
    assert.equal(a.totalProductionMinutes, 0);
  });

  it('uses available stock, not on-hand (reserved units are taken)', () => {
    // CARD-THANK: 30 on hand, 10 reserved -> 20 available.
    const l = assessInventory([line('CARD-THANK', 25)], PRODUCTS).lines[0]!;
    assert.equal(l.available, 20);
    assert.equal(l.fromStock, 20);
    assert.equal(l.toProduce, 5);
  });

  it('made-to-order items go fully to production', () => {
    const a = assessInventory([line('STK-CUSTOM', 3)], PRODUCTS);
    assert.equal(a.lines[0]!.status, 'made_to_order');
    assert.equal(a.lines[0]!.belowReorderPointAfter, false);
    assert.equal(a.totalProductionMinutes, 3 * 45);
    assert.equal(a.fulfillable, true);
  });

  it('bought-in items that are out of stock cannot be fulfilled', () => {
    // WASHI-PASTEL: 0 in stock, production time 0 (bought from a supplier).
    const a = assessInventory([line('WASHI-PASTEL', 2), line('STK-HOLO', 1)], PRODUCTS);
    const washi = a.lines[0]!;
    assert.equal(washi.status, 'out_of_stock');
    assert.equal(washi.producible, false);
    assert.equal(washi.unfulfillable, 2);
    assert.equal(a.lines[1]!.unfulfillable, 0);
    assert.equal(a.fulfillable, false);
  });

  it('two lines for the same product share its stock', () => {
    const a = assessInventory([line('STK-PINK', 1), line('STK-PINK', 2)], PRODUCTS);
    assert.deepEqual(
      a.lines.map((l) => [l.fromStock, l.toProduce]),
      [
        [1, 0],
        [1, 1],
      ],
    );
  });

  it('throws if a product was not loaded', () => {
    assert.throws(() => assessInventory([{ productId: 999, quantity: 1 }], PRODUCTS), /999/);
  });
});

describe('suggestedReorder', () => {
  const item = (available: number, reorderPoint: number, madeToOrder = false) => ({
    madeToOrder,
    inventory: { available, reorderPoint },
  });
  it('tops low stock up to twice the reorder point', () => {
    assert.equal(suggestedReorder(item(2, 5)), 8);
    assert.equal(suggestedReorder(item(0, 6)), 12);
    assert.equal(suggestedReorder(item(5, 5)), 5);
  });
  it('suggests nothing when stock is fine, made to order, or has no reorder point', () => {
    assert.equal(suggestedReorder(item(6, 5)), null);
    assert.equal(suggestedReorder(item(0, 0, true)), null);
    assert.equal(suggestedReorder(item(0, 0)), null);
  });
});
