import { z } from 'zod';
import type { PricingRuleDto, ProductDto } from '@sbom/shared';
import { matchProduct } from '../domain/productMatching.js';
import { listPricingRules } from '../repositories/pricingRules.js';
import { listProducts } from '../repositories/products.js';
import { id } from './schemas.js';
import { defineTool } from './types.js';

const input = z
  .object({
    productId: id.optional().describe('Exact product id'),
    sku: z.string().trim().min(1).max(40).optional().describe('Exact SKU, e.g. STK-PINK'),
    query: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .optional()
      .describe('Free text from the customer, e.g. "pink sticker sheets"'),
  })
  .refine((v) => v.productId || v.sku || v.query, 'provide productId, sku, or query');

const withRules = (p: ProductDto, rules: PricingRuleDto[]) => ({
  ...p,
  volumeDiscounts: rules
    .filter(
      (r) => r.ruleType === 'volume_discount' && (r.productId === null || r.productId === p.id),
    )
    .map((r) => ({ name: r.name, minQuantity: r.minQuantity, percent: r.percent })),
});

export const getProductInformation = defineTool({
  name: 'getProductInformation',
  description:
    'Look up products in the catalogue by id, SKU, or free-text description. Returns price (in cents), ' +
    'stock (on hand, reserved, available), production minutes per unit, and volume discounts. ' +
    'For free text, returns the best match, or candidates when the text is ambiguous.',
  access: 'read',
  input,
  handler: async ({ productId, sku, query }) => {
    const [products, rules] = await Promise.all([
      listProducts(),
      listPricingRules({ activeOnly: true }),
    ]);

    if (productId || sku) {
      const p = products.find(
        (x) => x.id === productId || (sku && x.sku.toUpperCase() === sku.toUpperCase()),
      );
      return p
        ? { found: true as const, product: withRules(p, rules) }
        : {
            found: false as const,
            reason: `No product with ${productId ? `id ${productId}` : `SKU ${sku}`}`,
          };
    }

    const outcome = matchProduct(query!, products);
    if (outcome.kind === 'matched') {
      return {
        found: true as const,
        product: withRules(outcome.product, rules),
        matchScore: outcome.score,
      };
    }
    return {
      found: false as const,
      reason:
        outcome.kind === 'ambiguous'
          ? `"${query}" matches several products; ask the customer which one.`
          : `"${query}" doesn't match any product we sell.`,
      candidates: outcome.candidates.map((c) => ({
        productId: c.product.id,
        sku: c.product.sku,
        name: c.product.name,
        unitPriceCents: c.product.unitPriceCents,
        score: Math.round(c.score * 100) / 100,
      })),
    };
  },
});
