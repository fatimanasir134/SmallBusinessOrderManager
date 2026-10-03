import { z } from 'zod';
import type { CustomerTier } from '@sbom/shared';
import { discountOpportunities } from '../domain/alternatives.js';
import { calculatePrice, type PricingInput } from '../domain/pricing.js';
import { notFound } from '../lib/errors.js';
import { getCustomer } from '../repositories/customers.js';
import { listPricingRules } from '../repositories/pricingRules.js';
import { loadOrderProducts } from './catalog.js';
import { id, isoDay, mergeLines, orderLines } from './schemas.js';
import { defineTool } from './types.js';

const input = z.object({
  items: orderLines,
  customerId: id.optional().describe('Existing customer, for tier discounts'),
  requestedDeadline: isoDay.optional().describe('Deadline (YYYY-MM-DD), for rush surcharges'),
  discountRequested: z.boolean().optional().describe('Whether the customer asked for a discount'),
});

export const calculateOrderPrice = defineTool({
  name: 'calculateOrderPrice',
  description:
    'Price an order from the catalogue prices and pricing rules: volume discounts, customer tier ' +
    'discount, discount cap, and rush surcharge. Amounts are integer cents. Always use this tool ' +
    'for prices and discounts; never compute or promise them yourself. Also returns ' +
    'discountOpportunities: the nearest volume tier the customer could reach and what it costs.',
  access: 'read',
  input,
  handler: async ({ items, customerId, requestedDeadline, discountRequested }, ctx) => {
    const lines = mergeLines(items);
    const [products, rules] = await Promise.all([
      loadOrderProducts(lines.map((l) => l.productId)),
      listPricingRules({ activeOnly: true }),
    ]);

    let tier: CustomerTier | null = null;
    if (customerId) {
      const customer = await getCustomer(customerId);
      if (!customer) throw notFound(`Customer ${customerId} not found`);
      tier = customer.tier;
    }

    const pricingInput: PricingInput = {
      lines: lines.map((l, i) => ({ ...l, unitPriceCents: products[i]!.unitPriceCents })),
      rules,
      customerTier: tier,
      requestedDeadline: requestedDeadline ?? null,
      today: ctx.today,
      discountRequested,
    };
    const quote = calculatePrice(pricingInput);
    const nameOf = (pid: number) => products.find((p) => p.id === pid)!;
    return {
      ...quote,
      customerTier: tier,
      lines: quote.lines.map((l, i) => ({ ...l, sku: products[i]!.sku, name: products[i]!.name })),
      /** The nearest volume tier the customer could reach, with its real price. */
      discountOpportunities: discountOpportunities(pricingInput, quote).map((o) => ({
        ...o,
        sku: nameOf(o.productId).sku,
        name: nameOf(o.productId).name,
      })),
    };
  },
});
