/**
 * Stock movements. Each update is a single conditional UPDATE, so concurrent orders can't
 * oversell: if the condition fails, no row comes back and the caller gets a conflict.
 */
import { type Db, query } from '../db/client.js';
import { conflict } from '../lib/errors.js';

async function updateOrConflict(sql: string, params: unknown[], message: string, db?: Db) {
  const rows = await query(sql, params, db);
  if (rows.length === 0) throw conflict(message, { productId: params[0], quantity: params[1] });
}

/** Hold stock for an approved order (available -> reserved). */
export async function reserveStock(productId: number, quantity: number, db?: Db): Promise<void> {
  await updateOrConflict(
    `UPDATE inventory SET reserved = reserved + $2, updated_at = now()
     WHERE product_id = $1 AND available >= $2
     RETURNING product_id`,
    [productId, quantity],
    `Not enough available stock to reserve ${quantity} of product ${productId}`,
    db,
  );
}

/** Give back a reservation, e.g. when a confirmed order is cancelled. */
export async function releaseStock(productId: number, quantity: number, db?: Db): Promise<void> {
  await updateOrConflict(
    `UPDATE inventory SET reserved = reserved - $2, updated_at = now()
     WHERE product_id = $1 AND reserved >= $2
     RETURNING product_id`,
    [productId, quantity],
    `Cannot release ${quantity} reserved units of product ${productId}`,
    db,
  );
}

/** Ship reserved stock: it leaves both reserved and on_hand. */
export async function consumeReservedStock(
  productId: number,
  quantity: number,
  db?: Db,
): Promise<void> {
  await updateOrConflict(
    `UPDATE inventory SET reserved = reserved - $2, on_hand = on_hand - $2, updated_at = now()
     WHERE product_id = $1 AND reserved >= $2
     RETURNING product_id`,
    [productId, quantity],
    `Cannot ship ${quantity} units of product ${productId}: not enough reserved`,
    db,
  );
}

/** Add (positive) or remove (negative) physical stock: restocks, finished production, corrections. */
export async function adjustStock(productId: number, delta: number, db?: Db): Promise<void> {
  await updateOrConflict(
    `UPDATE inventory SET on_hand = on_hand + $2, updated_at = now()
     WHERE product_id = $1 AND on_hand + $2 >= reserved
     RETURNING product_id`,
    [productId, delta],
    `Stock adjustment of ${delta} for product ${productId} would drop below reserved units`,
    db,
  );
}
