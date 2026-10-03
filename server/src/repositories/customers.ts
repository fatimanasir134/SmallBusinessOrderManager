import type { Channel, CustomerDto, CustomerTier } from '@sbom/shared';
import { type Db, query, queryOne } from '../db/client.js';

export interface CustomerRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  channel: Channel;
  tier: CustomerTier;
  notes: string;
  created_at: string;
}

export const toCustomerDto = (r: CustomerRow): CustomerDto => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  channel: r.channel,
  tier: r.tier,
  notes: r.notes,
  createdAt: r.created_at,
});

export async function listCustomers(db?: Db): Promise<CustomerDto[]> {
  const rows = await query<CustomerRow>('SELECT * FROM customers ORDER BY name', [], db);
  return rows.map(toCustomerDto);
}

export async function getCustomer(id: number, db?: Db): Promise<CustomerDto | undefined> {
  const row = await queryOne<CustomerRow>('SELECT * FROM customers WHERE id = $1', [id], db);
  return row && toCustomerDto(row);
}

export async function findCustomerByEmail(
  email: string,
  db?: Db,
): Promise<CustomerDto | undefined> {
  const row = await queryOne<CustomerRow>(
    'SELECT * FROM customers WHERE lower(email) = lower($1)',
    [email],
    db,
  );
  return row && toCustomerDto(row);
}

export interface NewCustomer {
  name: string;
  email?: string | null;
  phone?: string | null;
  channel?: Channel;
  tier?: CustomerTier;
  notes?: string;
}

export async function createCustomer(c: NewCustomer, db?: Db): Promise<CustomerDto> {
  const row = await queryOne<CustomerRow>(
    `INSERT INTO customers (name, email, phone, channel, tier, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      c.name,
      c.email ?? null,
      c.phone ?? null,
      c.channel ?? 'email',
      c.tier ?? 'standard',
      c.notes ?? '',
    ],
    db,
  );
  return toCustomerDto(row!);
}

/** Phone numbers are compared on their last 9 digits, so "+44 7700 900123" matches "07700 900123". */
export async function findCustomerByPhone(
  phone: string,
  db?: Db,
): Promise<CustomerDto | undefined> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return undefined;
  const row = await queryOne<CustomerRow>(
    `SELECT * FROM customers
     WHERE phone IS NOT NULL AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = right($1, 9)`,
    [digits],
    db,
  );
  return row && toCustomerDto(row);
}

export async function searchCustomersByName(
  name: string,
  limit = 5,
  db?: Db,
): Promise<CustomerDto[]> {
  const rows = await query<CustomerRow>(
    `SELECT * FROM customers WHERE name ILIKE '%' || $1 || '%' ORDER BY name LIMIT $2`,
    [name.trim(), limit],
    db,
  );
  return rows.map(toCustomerDto);
}

export interface CustomerOrderStats {
  totalOrders: number;
  completedOrders: number;
  openOrders: number;
  lifetimeSpendCents: number;
  lastOrderAt: string | null;
}

export async function getCustomerOrderStats(
  customerId: number,
  db?: Db,
): Promise<CustomerOrderStats> {
  const row = await queryOne<{
    total: number;
    completed: number;
    open: number;
    spend: number;
    last_order_at: string | null;
  }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled', 'rejected')) AS open,
            COALESCE(SUM(total_cents) FILTER (WHERE status = 'completed'), 0) AS spend,
            MAX(created_at) AS last_order_at
     FROM orders WHERE customer_id = $1`,
    [customerId],
    db,
  );
  return {
    totalOrders: row?.total ?? 0,
    completedOrders: row?.completed ?? 0,
    openOrders: row?.open ?? 0,
    lifetimeSpendCents: row?.spend ?? 0,
    lastOrderAt: row?.last_order_at ?? null,
  };
}
