/**
 * Business invariants, checked against the live data (`npm run db:check`, and in tests):
 *  - reserved stock equals what holding orders have reserved;
 *  - booked production minutes equal the recorded bookings;
 *  - no released order still holds stock;
 *  - every step that commits or ends an order (confirm, reject, cancel, fulfil) was made by a human.
 */
import type { Db } from './client.js';
import { query } from './client.js';

const HOLDING = `('confirmed', 'in_production', 'ready')`;
const HUMAN_ONLY = `('confirmed', 'rejected', 'cancelled', 'in_production', 'ready', 'completed')`;

export interface ConsistencyReport {
  ok: boolean;
  problems: string[];
}

export async function checkConsistency(db?: Db): Promise<ConsistencyReport> {
  const problems: string[] = [];

  const stock = await query<{ sku: string; reserved: number; expected: number }>(
    `SELECT p.sku, i.reserved,
            COALESCE(SUM(oi.reserved_quantity) FILTER (WHERE o.status IN ${HOLDING}), 0) AS expected
     FROM inventory i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN order_items oi ON oi.product_id = i.product_id
     LEFT JOIN orders o ON o.id = oi.order_id
     GROUP BY p.sku, i.reserved
     HAVING i.reserved <> COALESCE(SUM(oi.reserved_quantity) FILTER (WHERE o.status IN ${HOLDING}), 0)`,
    [],
    db,
  );
  for (const r of stock) {
    problems.push(`${r.sku}: ${r.reserved} reserved, but holding orders account for ${r.expected}`);
  }

  const capacity = await query<{ day: string; booked: number; recorded: number }>(
    `SELECT pc.day, pc.booked_minutes AS booked, COALESCE(SUM(pb.minutes), 0) AS recorded
     FROM production_capacity pc
     LEFT JOIN production_bookings pb ON pb.day = pc.day
     GROUP BY pc.day, pc.booked_minutes
     HAVING pc.booked_minutes <> COALESCE(SUM(pb.minutes), 0)`,
    [],
    db,
  );
  for (const r of capacity) {
    problems.push(`${r.day}: ${r.booked} production minutes booked, ${r.recorded} recorded`);
  }

  const leaks = await query<{ id: number; status: string }>(
    `SELECT DISTINCT o.id, o.status FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE oi.reserved_quantity > 0 AND o.status NOT IN ${HOLDING} AND o.status <> 'completed'`,
    [],
    db,
  );
  for (const r of leaks) problems.push(`order ${r.id} is ${r.status} but still holds stock`);

  const unapproved = await query<{ order_id: number; to_status: string; actor: string }>(
    `SELECT order_id, to_status, actor FROM order_status_history
     WHERE to_status IN ${HUMAN_ONLY} AND actor <> 'human'`,
    [],
    db,
  );
  for (const r of unapproved) {
    problems.push(`order ${r.order_id}: moved to ${r.to_status} by ${r.actor}, not a human`);
  }

  return { ok: problems.length === 0, problems };
}
