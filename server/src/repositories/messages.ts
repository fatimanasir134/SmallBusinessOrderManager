import type { Channel, MessageDto } from '@sbom/shared';
import { type Db, query, queryOne } from '../db/client.js';

interface MessageRow {
  id: number;
  customer_id: number | null;
  order_id: number | null;
  direction: 'inbound' | 'outbound';
  channel: Channel;
  body: string;
  created_at: string;
}

const toDto = (r: MessageRow): MessageDto => ({
  id: r.id,
  customerId: r.customer_id,
  orderId: r.order_id,
  direction: r.direction,
  channel: r.channel,
  body: r.body,
  createdAt: r.created_at,
});

export interface NewMessage {
  customerId?: number | null;
  orderId?: number | null;
  direction: 'inbound' | 'outbound';
  channel?: Channel;
  body: string;
}

export async function createMessage(m: NewMessage, db?: Db): Promise<MessageDto> {
  const row = await queryOne<MessageRow>(
    `INSERT INTO messages (customer_id, order_id, direction, channel, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [m.customerId ?? null, m.orderId ?? null, m.direction, m.channel ?? 'email', m.body],
    db,
  );
  return toDto(row!);
}

export async function listMessagesForOrder(orderId: number, db?: Db): Promise<MessageDto[]> {
  const rows = await query<MessageRow>(
    'SELECT * FROM messages WHERE order_id = $1 ORDER BY created_at, id',
    [orderId],
    db,
  );
  return rows.map(toDto);
}
