import { z } from 'zod';
import { deadlineAlternatives } from '../domain/alternatives.js';
import { addDays } from '../domain/dates.js';
import { assessInventory } from '../domain/inventory.js';
import { estimateCompletion } from '../domain/production.js';
import { listCapacity } from '../repositories/capacity.js';
import { loadOrderProducts } from './catalog.js';
import { PLANNING_HORIZON_DAYS } from './checkProductionCapacity.js';
import { isoDay, mergeLines, orderLines } from './schemas.js';
import { defineTool } from './types.js';

const input = z.object({
  items: orderLines,
  requestedDeadline: isoDay.optional().describe("Customer's deadline (YYYY-MM-DD), if any"),
});

export const calculateEstimatedCompletion = defineTool({
  name: 'calculateEstimatedCompletion',
  description:
    'Estimate when an order can be ready: uses available stock first, schedules production for ' +
    'the shortfall, and compares the completion date with the deadline. Use this to answer ' +
    '"can you do it by X?". When the deadline cannot be met it returns alternatives: the earliest ' +
    'date, a smaller quantity that fits the deadline, or a split delivery.',
  access: 'read',
  input,
  handler: async ({ items, requestedDeadline }, ctx) => {
    const lines = mergeLines(items);
    const products = await loadOrderProducts(lines.map((l) => l.productId));
    const stock = assessInventory(lines, products);
    const days = await listCapacity(ctx.today, addDays(ctx.today, PLANNING_HORIZON_DAYS));
    const estimate = estimateCompletion(
      stock.totalProductionMinutes,
      days,
      ctx.today,
      requestedDeadline ?? null,
    );
    // If the deadline is missed, also report the earliest possible date (ignoring the deadline).
    const earliest =
      estimate.meetsDeadline === false
        ? estimateCompletion(stock.totalProductionMinutes, days, ctx.today, null)
            .estimatedCompletionDate
        : estimate.estimatedCompletionDate;
    // Deadline missed: real options from stock and free capacity.
    const alternatives =
      estimate.meetsDeadline === false && requestedDeadline
        ? deadlineAlternatives({
            stock,
            minutesPerUnit: new Map(products.map((p) => [p.id, p.productionMinutesPerUnit])),
            freeMinutesByDeadline: estimate.plan.freeMinutesInWindow,
            earliestPossibleDate: earliest,
            today: ctx.today,
            deadline: requestedDeadline,
          })
        : [];
    return {
      ...estimate,
      earliestPossibleDate: earliest,
      alternatives,
      stock: stock.lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        requested: l.requested,
        fromStock: l.fromStock,
        toProduce: l.toProduce,
        status: l.status,
      })),
    };
  },
});
