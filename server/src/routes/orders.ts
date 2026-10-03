import { Router } from 'express';
import { z } from 'zod';
import { ORDER_STATUSES } from '@sbom/shared';
import { todayIso } from '../domain/dates.js';
import { AppError, notFound } from '../lib/errors.js';
import { withOrderLock } from '../lib/orderLock.js';
import { executeTool } from '../tools/registry.js';
import { getLatestApproval } from '../repositories/approvals.js';
import { getOrderDetail, listOrders } from '../repositories/orders.js';
import {
  approveOrder,
  continueWithCustomerReply,
  rejectOrder,
  retryWorkflow,
} from '../workflow/orderWorkflow.js';
import { logger } from '../lib/logger.js';

export const ordersRouter = Router();

const listQuery = z.object({ status: z.enum(ORDER_STATUSES).optional() });

ordersRouter.get('/', async (req, res) => {
  const { status } = listQuery.parse(req.query);
  res.json(await listOrders(status));
});

/** Order with customer, items, status history, messages, and agent trace. */
ordersRouter.get('/:id', async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const order = await getOrderDetail(id);
  if (!order) throw notFound(`Order ${id} not found`);
  res.json(order);
});

const idParam = (raw: string) => z.coerce.number().int().positive().parse(raw);

const decisionBody = z.object({
  decidedBy: z.string().trim().min(1).max(100).optional().describe('Who decided (no login yet)'),
  note: z.string().trim().max(500).optional(),
  reply: z.string().trim().max(2000).optional().describe('Edited reply; defaults to the draft'),
});

/** The latest approval request for an order (the approval state the person decides on). */
ordersRouter.get('/:id/approval', async (req, res) => {
  const approval = await getLatestApproval(idParam(req.params.id));
  if (!approval) throw notFound('This order has no approval request');
  res.json(approval);
});

/**
 * APPROVE: the Order Management Agent confirms the order (re-checks and reserves stock, books
 * production), the decision is recorded, and the reply becomes the final response.
 */
ordersRouter.post('/:id/approve', async (req, res) => {
  res.json(await approveOrder(idParam(req.params.id), decisionBody.parse(req.body ?? {})));
});

/** REJECT: nothing is confirmed; the decision (and optionally the reply sent) is recorded. */
ordersRouter.post('/:id/reject', async (req, res) => {
  const input = decisionBody
    .extend({ sendReply: z.boolean().optional().describe('Send the (draft or edited) reply') })
    .parse(req.body ?? {});
  res.json(await rejectOrder(idParam(req.params.id), input));
});

/**
 * Fulfilment steps by a person: confirmed -> in_production -> ready -> completed (or cancel).
 * Runs through the order tool, so transitions, permissions, and stock/capacity effects apply.
 */
ordersRouter.post('/:id/status', async (req, res) => {
  const id = idParam(req.params.id);
  const input = z
    .object({
      status: z.enum(['in_production', 'ready', 'completed', 'cancelled']),
      note: z.string().trim().max(500).optional(),
    })
    .parse(req.body ?? {});
  const r = await withOrderLock(id, () =>
    executeTool(
      'updateOrderStatus',
      { orderId: id, status: input.status, note: input.note },
      { actor: 'human', today: todayIso(), orderId: id },
    ),
  );
  if (!r.ok) {
    const status =
      r.error.code === 'NOT_FOUND' ? 404 : r.error.code === 'INVALID_ARGUMENTS' ? 400 : 409;
    throw new AppError(status, r.error.code, r.error.message, r.error.details);
  }
  res.json(await getOrderDetail(id));
});

/**
 * The customer answered a clarifying question: resume the paused order with the whole conversation.
 * Responds 202 at once; the agents keep working (poll GET /api/orders/:id).
 */
ordersRouter.post('/:id/reply', async (req, res) => {
  const id = idParam(req.params.id);
  const { message } = z
    .object({ message: z.string().trim().min(1, 'message is empty').max(4000) })
    .parse(req.body ?? {});
  let started: () => void = () => undefined;
  const resumed = new Promise<void>((resolve) => (started = resolve));
  const done = continueWithCustomerReply(id, message, { onOrderCreated: () => started() });
  await Promise.race([resumed, done]);
  res.status(202).json({ orderId: id });
  done.catch((err) => logger.error('resumed workflow failed', { orderId: id, err }));
});

/** Resume a workflow that stopped on an agent error; successful steps are reused. */
ordersRouter.post('/:id/retry', async (req, res) => {
  res.json(await retryWorkflow(idParam(req.params.id)));
});
