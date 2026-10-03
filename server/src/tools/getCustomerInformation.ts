import { z } from 'zod';
import type { CustomerDto } from '@sbom/shared';
import {
  findCustomerByEmail,
  findCustomerByPhone,
  getCustomer,
  getCustomerOrderStats,
  searchCustomersByName,
} from '../repositories/customers.js';
import { listOrdersForCustomer } from '../repositories/orders.js';
import { listPricingRules } from '../repositories/pricingRules.js';
import { id } from './schemas.js';
import { defineTool } from './types.js';

const input = z
  .object({
    customerId: id.optional(),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    name: z.string().trim().min(2).max(100).optional().describe('Full or partial name'),
  })
  .refine(
    (v) => v.customerId || v.email || v.phone || v.name,
    'provide customerId, email, phone, or name',
  );

export const getCustomerInformation = defineTool({
  name: 'getCustomerInformation',
  description:
    'Find a customer by id, email, phone, or name. Returns their tier (standard, loyal, wholesale), ' +
    'the tier discount they get, order history stats, and recent orders. ' +
    'found=false means this is a new customer.',
  access: 'read',
  input,
  handler: async ({ customerId, email, phone, name }) => {
    // Most specific identifier wins.
    let customer: CustomerDto | undefined;
    if (customerId) customer = await getCustomer(customerId);
    if (!customer && email) customer = await findCustomerByEmail(email);
    if (!customer && phone) customer = await findCustomerByPhone(phone);

    if (!customer && name) {
      const matches = await searchCustomersByName(name);
      if (matches.length === 1) customer = matches[0];
      else if (matches.length > 1) {
        return {
          found: false as const,
          reason: `Several customers match "${name}"; use their email or phone to pick one.`,
          candidates: matches.map((m) => ({ customerId: m.id, name: m.name, email: m.email })),
        };
      }
    }
    if (!customer) return { found: false as const, reason: 'No matching customer: treat as new.' };

    const [stats, recentOrders, rules] = await Promise.all([
      getCustomerOrderStats(customer.id),
      listOrdersForCustomer(customer.id, 5),
      listPricingRules({ activeOnly: true }),
    ]);
    const tierDiscount = rules.find(
      (r) => r.ruleType === 'customer_tier_discount' && r.customerTier === customer.tier,
    );
    return {
      found: true as const,
      customer,
      tierDiscountPercent: tierDiscount?.percent ?? 0,
      stats,
      recentOrders: recentOrders.map((o) => ({
        orderId: o.id,
        status: o.status,
        totalCents: o.totalCents,
        createdAt: o.createdAt,
      })),
    };
  },
});
