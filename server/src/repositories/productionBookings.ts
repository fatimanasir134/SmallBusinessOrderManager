import type { ProductionBookingDto } from '@sbom/shared';
import { type Db, query } from '../db/client.js';

export async function listProductionBookings(
  orderId: number,
  db?: Db,
): Promise<ProductionBookingDto[]> {
  return query<ProductionBookingDto>(
    'SELECT day, minutes FROM production_bookings WHERE order_id = $1 ORDER BY day',
    [orderId],
    db,
  );
}

export async function addProductionBooking(
  orderId: number,
  day: string,
  minutes: number,
  db?: Db,
): Promise<void> {
  await query(
    'INSERT INTO production_bookings (order_id, day, minutes) VALUES ($1, $2, $3)',
    [orderId, day, minutes],
    db,
  );
}

export async function deleteProductionBookings(orderId: number, db?: Db): Promise<void> {
  await query('DELETE FROM production_bookings WHERE order_id = $1', [orderId], db);
}
