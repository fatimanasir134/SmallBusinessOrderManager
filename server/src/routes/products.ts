import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors.js';
import { todayIso } from '../domain/dates.js';
import { listStockReceipts } from '../repositories/stockReceipts.js';
import { executeTool } from '../tools/registry.js';
import { getProduct, listProducts } from '../repositories/products.js';

export const productsRouter = Router();

/** Products with their inventory (on hand, reserved, available, low-stock flag). */
productsRouter.get('/', async (_req, res) => {
  res.json(await listProducts());
});

productsRouter.get('/receipts', async (req, res) => {
  const { limit } = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(10) })
    .parse(req.query);
  res.json(await listStockReceipts(limit));
});

productsRouter.get('/:id', async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const product = await getProduct(id);
  if (!product) throw notFound(`Product ${id} not found`);
  res.json(product);
});

/**
 * Receive stock (human action). Goes through the restockProduct tool: validation, made-to-order
 * check, the stock change, and the audit record in one transaction.
 */
productsRouter.post('/:id/restock', async (req, res) => {
  const productId = z.coerce.number().int().positive().parse(req.params.id);
  const body = z
    .object({
      quantity: z.number().int().positive().max(10_000),
      receivedBy: z.string().trim().min(1).max(100).optional(),
      note: z.string().trim().max(300).optional(),
    })
    .parse(req.body ?? {});
  const r = await executeTool(
    'restockProduct',
    { productId, ...body },
    { actor: 'human', today: todayIso() },
  );
  if (!r.ok) {
    const status = r.error.code === 'NOT_FOUND' ? 404 : r.error.code === 'FORBIDDEN' ? 403 : 400;
    throw new AppError(status, r.error.code, r.error.message, r.error.details);
  }
  res.json(r.result);
});
