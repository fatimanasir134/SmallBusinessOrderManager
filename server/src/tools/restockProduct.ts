/**
 * Receive stock for a product (a supplier delivery, or a batch the studio made).
 * Human-only: no agent is given this tool, and the tool itself refuses any other caller.
 * The stock change and its audit record are written in one transaction.
 */
import { z } from 'zod';
import { transaction } from '../db/client.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { adjustStock } from '../repositories/inventory.js';
import { getProduct } from '../repositories/products.js';
import { recordStockReceipt } from '../repositories/stockReceipts.js';
import { id } from './schemas.js';
import { defineTool } from './types.js';

export const MAX_RESTOCK = 10_000;

const input = z.object({
  productId: id,
  quantity: z.number().int().positive().max(MAX_RESTOCK).describe('Units received'),
  receivedBy: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(300).optional().describe('e.g. supplier or batch reference'),
});

export const restockProduct = defineTool({
  name: 'restockProduct',
  description:
    'Record stock received for a product (supplier delivery or finished batch): increases on-hand ' +
    'stock and logs who received it. Only a person can do this.',
  access: 'write',
  input,
  handler: async ({ productId, quantity, receivedBy, note }, ctx) => {
    if (ctx.actor !== 'human') {
      throw new AppError(403, 'FORBIDDEN', 'Only a person can record received stock.');
    }
    return transaction(async (db) => {
      const product = await getProduct(productId, db);
      if (!product) throw notFound(`Product ${productId} not found`);
      if (product.madeToOrder) {
        throw badRequest(`${product.name} is made to order and is never kept in stock`);
      }
      await adjustStock(productId, quantity, db);
      const after = (await getProduct(productId, db))!;
      const receiptId = await recordStockReceipt(
        {
          productId,
          quantity,
          onHandAfter: after.inventory.onHand,
          receivedBy: receivedBy ?? 'shop owner',
          note: note ?? '',
        },
        db,
      );
      return { receiptId, product: after };
    });
  },
});
