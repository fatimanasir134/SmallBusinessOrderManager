/**
 * Move an order through its lifecycle, applying the business side effects of each step:
 *   -> confirmed   reserve stock, book production time, set the promised date (human only)
 *   -> cancelled   release whatever the order held
 *   -> completed   ship the reserved stock (it leaves on_hand)
 * Everything happens in one transaction, so a failure (e.g. stock sold in the meantime) changes nothing.
 */
import { z } from 'zod';
import { ORDER_STATUSES, type OrderStatus } from '@sbom/shared';
import { type Db, transaction } from '../db/client.js';
import { addDays } from '../domain/dates.js';
import { assessInventory } from '../domain/inventory.js';
import { HOLDS_RESOURCES, checkTransition } from '../domain/orderPolicy.js';
import { planProduction } from '../domain/production.js';
import { AppError, conflict } from '../lib/errors.js';
import { bookCapacity, listCapacity, releaseCapacity } from '../repositories/capacity.js';
import { consumeReservedStock, releaseStock, reserveStock } from '../repositories/inventory.js';
import {
  listOrderItems,
  lockOrder,
  setReservedQuantity,
  updateOrder,
  updateOrderStatus as writeStatus,
} from '../repositories/orders.js';
import {
  addProductionBooking,
  deleteProductionBookings,
  listProductionBookings,
} from '../repositories/productionBookings.js';
import { loadOrderProducts } from './catalog.js';
import { PLANNING_HORIZON_DAYS } from './checkProductionCapacity.js';
import { id } from './schemas.js';
import { defineTool } from './types.js';

const input = z.object({
  orderId: id,
  status: z.enum(ORDER_STATUSES).describe('New status'),
  note: z.string().trim().max(500).optional().describe('Why the status changed'),
});

interface Effects {
  reserved: { productId: number; quantity: number }[];
  productionBooked: { day: string; minutes: number }[];
  released: { productId: number; quantity: number }[];
  productionReleased: { day: string; minutes: number }[];
  shipped: { productId: number; quantity: number }[];
  promisedDate?: string;
}

async function confirm(orderId: number, today: string, db: Db, effects: Effects) {
  const items = await listOrderItems(orderId, db);
  if (items.length === 0) throw conflict(`Order ${orderId} has no items to confirm`);

  const products = await loadOrderProducts(
    items.map((i) => i.productId),
    db,
  );
  const stock = assessInventory(items, products);
  if (!stock.fulfillable) {
    const short = stock.lines.filter((l) => l.unfulfillable > 0);
    throw conflict(
      `Cannot confirm: ${short.map((l) => `${l.unfulfillable} x ${l.name}`).join(', ')} ` +
        'can neither ship from stock nor be produced',
      { unfulfillable: short.map((l) => ({ productId: l.productId, quantity: l.unfulfillable })) },
    );
  }

  for (const line of stock.lines) {
    if (line.fromStock === 0) continue;
    await reserveStock(line.productId, line.fromStock, db); // conflict if sold meanwhile
    await setReservedQuantity(orderId, line.productId, line.fromStock, db);
    effects.reserved.push({ productId: line.productId, quantity: line.fromStock });
  }

  const days = await listCapacity(today, addDays(today, PLANNING_HORIZON_DAYS), db);
  const plan = planProduction(stock.totalProductionMinutes, days, today);
  if (!plan.fitsInHorizon) {
    throw conflict(
      `Not enough production capacity in the next ${PLANNING_HORIZON_DAYS} days ` +
        `(${stock.totalProductionMinutes} minutes needed)`,
    );
  }
  for (const slot of plan.schedule) {
    await bookCapacity(slot.day, slot.minutes, db);
    await addProductionBooking(orderId, slot.day, slot.minutes, db);
    effects.productionBooked.push(slot);
  }
  effects.promisedDate = plan.completionDay!;
  await updateOrder(orderId, { promisedDate: plan.completionDay }, db);
}

async function release(orderId: number, db: Db, effects: Effects) {
  for (const item of await listOrderItems(orderId, db)) {
    if (item.reservedQuantity === 0) continue;
    await releaseStock(item.productId, item.reservedQuantity, db);
    await setReservedQuantity(orderId, item.productId, 0, db);
    effects.released.push({ productId: item.productId, quantity: item.reservedQuantity });
  }
  for (const b of await listProductionBookings(orderId, db)) {
    await releaseCapacity(b.day, b.minutes, db);
    effects.productionReleased.push(b);
  }
  await deleteProductionBookings(orderId, db);
}

async function ship(orderId: number, db: Db, effects: Effects) {
  for (const item of await listOrderItems(orderId, db)) {
    if (item.reservedQuantity === 0) continue;
    await consumeReservedStock(item.productId, item.reservedQuantity, db);
    effects.shipped.push({ productId: item.productId, quantity: item.reservedQuantity });
  }
}

export const updateOrderStatus = defineTool({
  name: 'updateOrderStatus',
  description:
    'Change an order status. Agents may only set processing, needs_info, needs_review, or ' +
    'awaiting_approval; approving (confirmed), rejecting, and fulfilment steps require a human. ' +
    'Confirming reserves stock and books production time; cancelling releases them.',
  access: 'write',
  input,
  handler: async ({ orderId, status: to, note }, ctx) =>
    transaction(async (db) => {
      const from: OrderStatus = await lockOrder(orderId, db);
      const check = checkTransition(from, to, ctx.actor);
      if (!check.ok) {
        throw new AppError(check.code === 'FORBIDDEN' ? 403 : 409, check.code, check.reason, {
          from,
          to,
          actor: ctx.actor,
        });
      }

      const effects: Effects = {
        reserved: [],
        productionBooked: [],
        released: [],
        productionReleased: [],
        shipped: [],
      };
      if (to === 'confirmed') await confirm(orderId, ctx.today, db, effects);
      else if (to === 'cancelled' && HOLDS_RESOURCES.includes(from))
        await release(orderId, db, effects);
      else if (to === 'completed') await ship(orderId, db, effects);

      await writeStatus(orderId, to, ctx.actor, note, db);
      return { orderId, from, to, actor: ctx.actor, effects };
    }),
});
