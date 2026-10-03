import type { StockReceiptDto } from '@sbom/shared';
import { type Db, query, queryOne } from '../db/client.js';

interface ReceiptRow {
  id: number;
  product_id: number;
  sku: string;
  product_name: string;
  quantity: number;
  on_hand_after: number;
  received_by: string;
  note: string;
  created_at: string;
}

const toDto = (r: ReceiptRow): StockReceiptDto => ({
  id: r.id,
  productId: r.product_id,
  sku: r.sku,
  productName: r.product_name,
  quantity: r.quantity,
  onHandAfter: r.on_hand_after,
  receivedBy: r.received_by,
  note: r.note,
  createdAt: r.created_at,
});

export async function recordStockReceipt(
  r: { productId: number; quantity: number; onHandAfter: number; receivedBy: string; note: string },
  db?: Db,
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO stock_receipts (product_id, quantity, on_hand_after, received_by, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [r.productId, r.quantity, r.onHandAfter, r.receivedBy, r.note],
    db,
  );
  return row!.id;
}

export async function listStockReceipts(limit = 10, db?: Db): Promise<StockReceiptDto[]> {
  const rows = await query<ReceiptRow>(
    `SELECT s.*, p.sku, p.name AS product_name
     FROM stock_receipts s JOIN products p ON p.id = s.product_id
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT $1`,
    [limit],
    db,
  );
  return rows.map(toDto);
}
