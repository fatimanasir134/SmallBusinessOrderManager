import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRODUCTS } from '../test/fixtures.js';
import { matchProduct, tokenize } from './productMatching.js';

const skuOf = (query: string) => {
  const m = matchProduct(query, PRODUCTS);
  return m.kind === 'matched' ? m.product.sku : m.kind;
};

describe('tokenize', () => {
  it('lowercases, drops filler words, and singularises', () => {
    assert.deepEqual(tokenize('3 Pink Sticker Sheets, please!'), ['3', 'pink', 'sticker', 'sheet']);
    assert.deepEqual(tokenize('die-cut stickers'), ['die', 'cut', 'sticker']);
  });
});

describe('matchProduct', () => {
  const cases: [string, string][] = [
    ['pink sticker sheets', 'STK-PINK'],
    ['Pink sticker sheet', 'STK-PINK'],
    ['STK-PINK', 'STK-PINK'],
    ['stk-holo', 'STK-HOLO'],
    ['holo stickers', 'STK-HOLO'],
    ['holographic sheet', 'STK-HOLO'],
    ['custom die cut stickers', 'STK-CUSTOM'],
    ['thank you cards', 'CARD-THANK'],
    ['floral bookmarks', 'BKMK-FLORAL'],
    ['washi tape', 'WASHI-PASTEL'],
    ['planner kit', 'PLAN-WEEKLY'],
  ];
  for (const [query, sku] of cases) {
    it(`"${query}" -> ${sku}`, () => assert.equal(skuOf(query), sku));
  }

  it('reports ambiguity for generic words, with candidates', () => {
    const m = matchProduct('stickers', PRODUCTS);
    assert.equal(m.kind, 'ambiguous');
    assert.ok(m.kind === 'ambiguous' && m.candidates.length >= 3);
  });

  it('returns none for products we do not sell', () => {
    assert.equal(skuOf('unicorn mug'), 'none');
    assert.equal(skuOf('ab'), 'none');
  });

  it('never matches inactive products', () => {
    const catalogue = PRODUCTS.map((p) => (p.sku === 'STK-PINK' ? { ...p, active: false } : p));
    const m = matchProduct('pink sticker sheet', catalogue);
    assert.ok(m.kind !== 'matched' || m.product.sku !== 'STK-PINK');
  });
});
