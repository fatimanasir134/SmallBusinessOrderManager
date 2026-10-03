import { z } from 'zod';
import { CHANNELS, type CustomerDto } from '@sbom/shared';
import { transaction } from '../db/client.js';
import { calculatePrice } from '../domain/pricing.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  createCustomer,
  findCustomerByEmail,
  findCustomerByPhone,
  getCustomer,
} from '../repositories/customers.js';
import { createMessage } from '../repositories/messages.js';
import { createOrder as insertOrder, setOrderItems, updateOrder } from '../repositories/orders.js';
import { listPricingRules } from '../repositories/pricingRules.js';
import { loadOrderProducts } from './catalog.js';
import { id, isoDay, mergeLines, orderLines } from './schemas.js';
import { defineTool } from './types.js';

const input = z
  .object({
    customerId: id.optional().describe('Existing customer id (from getCustomerInformation)'),
    newCustomer: z
      .object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(200).optional(),
        phone: z.string().trim().min(6).max(30).optional(),
      })
      .optional()
      .describe('Details for a customer not yet in the system'),
    items: orderLines,
    requestedDeadline: isoDay.optional(),
    discountRequested: z.boolean().optional(),
    channel: z.enum(CHANNELS).optional().describe('Where the message came from'),
    sourceMessage: z.string().trim().min(1).max(4000).optional().describe("The customer's message"),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.customerId || v.newCustomer, 'provide customerId or newCustomer');

export const createOrder = defineTool({
  name: 'createOrder',
  description:
    'Create a new order in status "received" with its items, priced by the backend. Finds or ' +
    'creates the customer and stores the original message. Does not reserve stock or confirm ' +
    'anything: confirmation needs human approval.',
  access: 'write',
  input,
  handler: async (args, ctx) => {
    if (args.requestedDeadline && args.requestedDeadline < ctx.today) {
      throw badRequest(`requestedDeadline ${args.requestedDeadline} is in the past`);
    }
    const lines = mergeLines(args.items);

    return transaction(async (db) => {
      // Resolve the customer: explicit id, then email/phone match, else create.
      let customer: CustomerDto | undefined;
      let customerCreated = false;
      if (args.customerId) {
        customer = await getCustomer(args.customerId, db);
        if (!customer) throw notFound(`Customer ${args.customerId} not found`);
      } else {
        const nc = args.newCustomer!;
        customer =
          (nc.email ? await findCustomerByEmail(nc.email, db) : undefined) ??
          (nc.phone ? await findCustomerByPhone(nc.phone, db) : undefined);
        if (!customer) {
          customer = await createCustomer(
            { name: nc.name, email: nc.email, phone: nc.phone, channel: args.channel },
            db,
          );
          customerCreated = true;
        }
      }

      const products = await loadOrderProducts(
        lines.map((l) => l.productId),
        db,
      );
      const priced = lines.map((l, i) => ({ ...l, unitPriceCents: products[i]!.unitPriceCents }));
      const quote = calculatePrice({
        lines: priced,
        rules: await listPricingRules({ activeOnly: true }, db),
        customerTier: customer.tier,
        requestedDeadline: args.requestedDeadline ?? null,
        today: ctx.today,
        discountRequested: args.discountRequested,
      });

      const orderId = await insertOrder(
        {
          customerId: customer.id,
          requestedDeadline: args.requestedDeadline ?? null,
          notes: args.notes,
          actor: ctx.actor,
        },
        db,
      );
      await setOrderItems(orderId, priced, db);
      await updateOrder(
        orderId,
        {
          subtotalCents: quote.subtotalCents,
          discountPercent: quote.discountPercent,
          surchargePercent: quote.surchargePercent,
          totalCents: quote.totalCents,
        },
        db,
      );
      if (args.sourceMessage) {
        await createMessage(
          {
            customerId: customer.id,
            orderId,
            direction: 'inbound',
            channel: args.channel ?? customer.channel,
            body: args.sourceMessage,
          },
          db,
        );
      }

      return {
        orderId,
        status: 'received' as const,
        customer: {
          id: customer.id,
          name: customer.name,
          tier: customer.tier,
          created: customerCreated,
        },
        quote,
      };
    });
  },
});
