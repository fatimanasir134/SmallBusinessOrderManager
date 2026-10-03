/** Catalogue and pricing rules mirroring the demo seed, for pure unit tests. */
import type { PricingRuleDto, ProductDto } from '@sbom/shared';

type P = Pick<
  ProductDto,
  | 'sku'
  | 'name'
  | 'description'
  | 'category'
  | 'unitPriceCents'
  | 'productionMinutesPerUnit'
  | 'madeToOrder'
> & {
  onHand: number;
  reserved?: number;
  reorderPoint: number;
};

const RAW: P[] = [
  {
    sku: 'STK-PINK',
    name: 'Pink sticker sheet',
    description: 'A5 sheet of pastel pink vinyl stickers',
    category: 'stickers',
    unitPriceCents: 450,
    productionMinutesPerUnit: 20,
    madeToOrder: false,
    onHand: 2,
    reorderPoint: 5,
  },
  {
    sku: 'STK-HOLO',
    name: 'Holographic sticker sheet',
    description: 'A5 sheet of holographic stickers',
    category: 'stickers',
    unitPriceCents: 650,
    productionMinutesPerUnit: 25,
    madeToOrder: false,
    onHand: 15,
    reorderPoint: 5,
  },
  {
    sku: 'STK-CUSTOM',
    name: 'Custom die-cut stickers (pack of 10)',
    description: 'Printed from customer artwork and die-cut to shape',
    category: 'stickers',
    unitPriceCents: 1200,
    productionMinutesPerUnit: 45,
    madeToOrder: true,
    onHand: 0,
    reorderPoint: 0,
  },
  {
    sku: 'PLAN-WEEKLY',
    name: 'Weekly planner sticker kit',
    description: '4 sheets of functional planner stickers',
    category: 'stickers',
    unitPriceCents: 1100,
    productionMinutesPerUnit: 35,
    madeToOrder: false,
    onHand: 8,
    reorderPoint: 8,
  },
  {
    sku: 'CARD-THANK',
    name: 'Thank-you cards (pack of 5)',
    description: 'Printed kraft thank-you cards with envelopes',
    category: 'cards',
    unitPriceCents: 800,
    productionMinutesPerUnit: 15,
    madeToOrder: false,
    onHand: 30,
    reserved: 10,
    reorderPoint: 10,
  },
  {
    sku: 'BKMK-FLORAL',
    name: 'Floral bookmark',
    description: 'Laminated floral bookmark with tassel',
    category: 'bookmarks',
    unitPriceCents: 350,
    productionMinutesPerUnit: 10,
    madeToOrder: false,
    onHand: 40,
    reorderPoint: 10,
  },
  {
    sku: 'WASHI-PASTEL',
    name: 'Pastel washi tape set',
    description: 'Set of 5 pastel washi tapes (bought in from our supplier)',
    category: 'tape',
    unitPriceCents: 950,
    productionMinutesPerUnit: 0,
    madeToOrder: false,
    onHand: 0,
    reorderPoint: 6,
  },
];

export const PRODUCTS: ProductDto[] = RAW.map((p, i) => {
  const reserved = p.reserved ?? 0;
  return {
    id: i + 1,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    unitPriceCents: p.unitPriceCents,
    productionMinutesPerUnit: p.productionMinutesPerUnit,
    madeToOrder: p.madeToOrder,
    active: true,
    inventory: {
      onHand: p.onHand,
      reserved,
      available: p.onHand - reserved,
      reorderPoint: p.reorderPoint,
      lowStock: p.onHand - reserved <= p.reorderPoint,
      suggestedReorder: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  };
});

export const product = (sku: string): ProductDto => {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) throw new Error(`fixture product ${sku} missing`);
  return p;
};

let ruleId = 0;
const rule = (
  r: Partial<PricingRuleDto> & Pick<PricingRuleDto, 'name' | 'ruleType' | 'percent'>,
): PricingRuleDto => ({
  id: ++ruleId,
  description: '',
  productId: null,
  customerTier: null,
  minQuantity: null,
  maxDaysUntilDeadline: null,
  active: true,
  ...r,
});

export const RULES: PricingRuleDto[] = [
  rule({ name: 'Volume 3+', ruleType: 'volume_discount', minQuantity: 3, percent: 5 }),
  rule({ name: 'Volume 10+', ruleType: 'volume_discount', minQuantity: 10, percent: 10 }),
  rule({ name: 'Volume 25+', ruleType: 'volume_discount', minQuantity: 25, percent: 15 }),
  rule({
    name: 'Card bundle',
    ruleType: 'volume_discount',
    productId: product('CARD-THANK').id,
    minQuantity: 5,
    percent: 12,
  }),
  rule({
    name: 'Loyal customer',
    ruleType: 'customer_tier_discount',
    customerTier: 'loyal',
    percent: 5,
  }),
  rule({
    name: 'Wholesale',
    ruleType: 'customer_tier_discount',
    customerTier: 'wholesale',
    percent: 15,
  }),
  rule({ name: 'Rush order', ruleType: 'rush_surcharge', maxDaysUntilDeadline: 2, percent: 20 }),
  rule({ name: 'Discount cap', ruleType: 'max_discount', percent: 20 }),
];
