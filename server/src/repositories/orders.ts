import {
  canTransition,
  type StopReason,
  type OrderDetailDto,
  type OrderItemDto,
  type OrderStatus,
  type OrderSummaryDto,
  type StatusActor,
  type StatusHistoryDto,
} from '@sbom/shared';
import { type Db, query, queryOne, transaction } from '../db/client.js';
import { conflict, notFound } from '../lib/errors.js';
import { listAgentRunsForOrder } from './agentRuns.js';
import { getLatestApproval } from './approvals.js';
import { listProductionBookings } from './productionBookings.js';
import { getCustomer } from './customers.js';
import { listMessagesForOrder } from './messages.js';

interface OrderRow {
  id: number;
  customer_id: number | null;
  customer_name: string | null;
  status: OrderStatus;
  requested_deadline: string | null;
  promised_date: string | null;
  subtotal_cents: number | null;
  discount_percent: number;
  surcharge_percent: number;
  total_cents: number | null;
  draft_reply: string | null;
  final_reply: string | null;
  notes: string;
  stop_reason: StopReason | null;
  customization: string | null;
  estimated_completion: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

interface OrderItemRow {
  id: number;
  product_id: number;
  sku: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  reserved_quantity: number;
}

interface HistoryRow {
  id: number;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor: StatusActor;
  note: string | null;
  created_at: string;
}

const SELECT_ORDERS = `
  SELECT o.*, c.name AS customer_name,
         (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id`;

const toSummary = (r: OrderRow): OrderSummaryDto => ({
  id: r.id,
  customerId: r.customer_id,
  customerName: r.customer_name,
  status: r.status,
  requestedDeadline: r.requested_deadline,
  promisedDate: r.promised_date,
  totalCents: r.total_cents,
  itemCount: r.item_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toItem = (r: OrderItemRow): OrderItemDto => ({
  id: r.id,
  productId: r.product_id,
  sku: r.sku,
  productName: r.product_name,
  quantity: r.quantity,
  unitPriceCents: r.unit_price_cents,
  lineTotalCents: r.line_total_cents,
  reservedQuantity: r.reserved_quantity,
});

const toHistory = (r: HistoryRow): StatusHistoryDto => ({
  id: r.id,
  fromStatus: r.from_status,
  toStatus: r.to_status,
  actor: r.actor,
  note: r.note,
  createdAt: r.created_at,
});

export async function listOrders(status?: OrderStatus, db?: Db): Promise<OrderSummaryDto[]> {
  const rows = await query<OrderRow>(
    `${SELECT_ORDERS} ${status ? 'WHERE o.status = $1' : ''} ORDER BY o.created_at DESC, o.id DESC`,
    status ? [status] : [],
    db,
  );
  return rows.map(toSummary);
}

export async function listOrdersForCustomer(
  customerId: number,
  limit = 10,
  db?: Db,
): Promise<OrderSummaryDto[]> {
  const rows = await query<OrderRow>(
    `${SELECT_ORDERS} WHERE o.customer_id = $1 ORDER BY o.created_at DESC, o.id DESC LIMIT $2`,
    [customerId, limit],
    db,
  );
  return rows.map(toSummary);
}

export async function listOrderItems(orderId: number, db?: Db): Promise<OrderItemDto[]> {
  const rows = await query<OrderItemRow>(
    `SELECT oi.id, oi.product_id, p.sku, p.name AS product_name, oi.quantity,
            oi.unit_price_cents, oi.line_total_cents, oi.reserved_quantity
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId],
    db,
  );
  return rows.map(toItem);
}

export async function listStatusHistory(orderId: number, db?: Db): Promise<StatusHistoryDto[]> {
  const rows = await query<HistoryRow>(
    'SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id',
    [orderId],
    db,
  );
  return rows.map(toHistory);
}

/** Full order: customer, items, status history, messages, and the agent trace. */
export async function getOrderDetail(id: number, db?: Db): Promise<OrderDetailDto | undefined> {
  const row = await queryOne<OrderRow>(`${SELECT_ORDERS} WHERE o.id = $1`, [id], db);
  if (!row) return undefined;

  // Sequential on purpose: `db` may be a single transaction client, which can't run queries in parallel.
  const customer = row.customer_id ? await getCustomer(row.customer_id, db) : undefined;
  return {
    ...toSummary(row),
    customer: customer ?? null,
    subtotalCents: row.subtotal_cents,
    discountPercent: row.discount_percent,
    surchargePercent: row.surcharge_percent,
    draftReply: row.draft_reply,
    finalReply: row.final_reply,
    notes: row.notes,
    stopReason: row.stop_reason,
    approval: (await getLatestApproval(id, db)) ?? null,
    customization: row.customization,
    estimatedCompletion: row.estimated_completion,
    items: await listOrderItems(id, db),
    productionBookings: await listProductionBookings(id, db),
    history: await listStatusHistory(id, db),
    messages: await listMessagesForOrder(id, db),
    agentRuns: await listAgentRunsForOrder(id, db),
  };
}

export interface NewOrder {
  customerId?: number | null;
  /** Client-supplied key; a second order with the same key is rejected by a unique index. */
  idempotencyKey?: string | null;
  requestedDeadline?: string | null;
  notes?: string;
  actor?: StatusActor;
}

/** Create an order in 'received' and record the first history entry. Returns the new id. */
export async function createOrder(o: NewOrder, db?: Db): Promise<number> {
  const run = async (client: Db) => {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO orders (customer_id, requested_deadline, notes, idempotency_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [o.customerId ?? null, o.requestedDeadline ?? null, o.notes ?? '', o.idempotencyKey ?? null],
      client,
    );
    const id = row!.id;
    await insertHistory(id, null, 'received', o.actor ?? 'system', 'Order created', client);
    return id;
  };
  return db ? run(db) : transaction(run);
}

export interface OrderLine {
  productId: number;
  quantity: number;
  unitPriceCents: number;
}

/** Replace the order's line items (agents may re-run and refine them). */
export async function setOrderItems(orderId: number, lines: OrderLine[], db?: Db): Promise<void> {
  const run = async (client: Db) => {
    await query('DELETE FROM order_items WHERE order_id = $1', [orderId], client);
    for (const l of lines) {
      await query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [orderId, l.productId, l.quantity, l.unitPriceCents],
        client,
      );
    }
    await query('UPDATE orders SET updated_at = now() WHERE id = $1', [orderId], client);
  };
  return db ? run(db) : transaction(run);
}

export interface OrderUpdate {
  customerId?: number | null;
  requestedDeadline?: string | null;
  promisedDate?: string | null;
  subtotalCents?: number | null;
  discountPercent?: number;
  surchargePercent?: number;
  totalCents?: number | null;
  draftReply?: string | null;
  finalReply?: string | null;
  notes?: string;
  stopReason?: StopReason | null;
  customization?: string | null;
  estimatedCompletion?: string | null;
}

const UPDATE_COLUMNS: Record<keyof OrderUpdate, string> = {
  customerId: 'customer_id',
  requestedDeadline: 'requested_deadline',
  promisedDate: 'promised_date',
  subtotalCents: 'subtotal_cents',
  discountPercent: 'discount_percent',
  surchargePercent: 'surcharge_percent',
  totalCents: 'total_cents',
  draftReply: 'draft_reply',
  finalReply: 'final_reply',
  notes: 'notes',
  stopReason: 'stop_reason',
  customization: 'customization',
  estimatedCompletion: 'estimated_completion',
};

/** Update order fields (not status: use updateOrderStatus). Only provided keys are changed. */
export async function updateOrder(id: number, changes: OrderUpdate, db?: Db): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, value] of Object.entries(changes)) {
    // Only known columns: column names come from this whitelist, never from input.
    if (value === undefined || !(key in UPDATE_COLUMNS)) continue;
    params.push(value);
    sets.push(`${UPDATE_COLUMNS[key as keyof OrderUpdate]} = $${params.length}`);
  }
  if (sets.length === 0) return;
  const rows = await query(
    `UPDATE orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
    params,
    db,
  );
  if (rows.length === 0) throw notFound(`Order ${id} not found`);
}

/**
 * Move an order to a new status, enforcing ORDER_TRANSITIONS and writing the history row.
 * The row is locked (FOR UPDATE) so two concurrent changes can't both pass the check.
 */
export async function updateOrderStatus(
  id: number,
  to: OrderStatus,
  actor: StatusActor,
  note?: string,
  db?: Db,
): Promise<void> {
  const run = async (client: Db) => {
    const row = await queryOne<{ status: OrderStatus }>(
      'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
      [id],
      client,
    );
    if (!row) throw notFound(`Order ${id} not found`);
    if (!canTransition(row.status, to)) {
      throw conflict(`Order ${id} cannot move from '${row.status}' to '${to}'`, {
        from: row.status,
        to,
      });
    }
    await query(
      'UPDATE orders SET status = $2, updated_at = now() WHERE id = $1',
      [id, to],
      client,
    );
    await insertHistory(id, row.status, to, actor, note ?? null, client);
  };
  return db ? run(db) : transaction(run);
}

async function insertHistory(
  orderId: number,
  from: OrderStatus | null,
  to: OrderStatus,
  actor: StatusActor,
  note: string | null,
  db: Db,
): Promise<void> {
  await query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, from, to, actor, note],
    db,
  );
}

/** Record how many units of a line were taken from stock at approval. */
export async function setReservedQuantity(
  orderId: number,
  productId: number,
  quantity: number,
  db?: Db,
): Promise<void> {
  await query(
    'UPDATE order_items SET reserved_quantity = $3 WHERE order_id = $1 AND product_id = $2',
    [orderId, productId, quantity],
    db,
  );
}

/** Lock the order row for the rest of the transaction and return its status. */
export async function lockOrder(id: number, db: Db): Promise<OrderStatus> {
  const row = await queryOne<{ status: OrderStatus }>(
    'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
    [id],
    db,
  );
  if (!row) throw notFound(`Order ${id} not found`);
  return row.status;
}

/** Order counts per status, for the dashboard. */
export async function countOrdersByStatus(db?: Db): Promise<Partial<Record<OrderStatus, number>>> {
  const rows = await query<{ status: OrderStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM orders GROUP BY status',
    [],
    db,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
