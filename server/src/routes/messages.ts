import { Router } from 'express';
import { z } from 'zod';
import { CHANNELS } from '@sbom/shared';
import { logger } from '../lib/logger.js';
import { processCustomerMessage } from '../workflow/orderWorkflow.js';

export const messagesRouter = Router();

const body = z.object({
  message: z.string().trim().min(1, 'message is empty').max(4000, 'message is too long'),
  channel: z.enum(CHANNELS).optional(),
  customerId: z.number().int().positive().optional(),
  customer: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().trim().email().max(200).optional(),
      phone: z.string().trim().min(6).max(30).optional(),
    })
    .optional(),
});
const query = z.object({ wait: z.enum(['true', 'false']).optional() });

/**
 * Ingest a customer message and run the multi-agent workflow up to the approval gate.
 *
 * Default: responds 202 with the order id as soon as the order is recorded, while the agents keep
 * working; poll GET /api/orders/:id to watch each step finish (the UI's workflow view does this).
 * With ?wait=true: responds 201 when the agents finish, with every step's decision.
 */
messagesRouter.post('/', async (req, res) => {
  const input = body.parse(req.body ?? {});
  const { wait } = query.parse(req.query);
  const idempotencyKey = z
    .string()
    .regex(/^[\w.:-]{8,100}$/, 'Idempotency-Key must be 8-100 letters, digits, or - _ . :')
    .optional()
    .parse(req.header('idempotency-key') ?? undefined);
  const message = { ...input, ...(idempotencyKey && { idempotencyKey }) };

  if (wait === 'true') {
    const result = await processCustomerMessage(message);
    res.status(result.duplicate ? 200 : 201).json(result);
    return;
  }

  type Created = { orderId: number; duplicate: boolean };
  let created: (c: Created) => void = () => undefined;
  const orderCreated = new Promise<Created>((resolve) => (created = resolve));
  const done = processCustomerMessage(message, {
    onOrderCreated: (orderId, info) => created({ orderId, duplicate: info?.duplicate ?? false }),
  });
  // Failures before the order exists (e.g. unknown customer) reject here and become the response.
  const first = await Promise.race([
    orderCreated,
    done.then((r) => ({ orderId: r.orderId, duplicate: Boolean(r.duplicate) })),
  ]);
  // 200 + duplicate: this message was already received; 202: a new order is being processed.
  res.status(first.duplicate ? 200 : 202).json(first);
  // Agent failures are already recorded on the order; anything else is logged.
  done.catch((err) => logger.error('background workflow failed', { orderId: first.orderId, err }));
});
