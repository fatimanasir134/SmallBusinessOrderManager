/**
 * Demo data for "Petal & Ink Studio", a small sticker and stationery business (fictional).
 * Dates are relative to today, so the demo always looks current.
 *
 * Key demo fact: only 2 pink sticker sheets are available, so the headline message
 * "I need 3 pink sticker sheets by Friday" causes a shortfall that production has to cover.
 */
import type pg from 'pg';
import type {
  ApprovalPacket,
  Channel,
  CustomerTier,
  OrderStatus,
  PricingRuleType,
  StatusActor,
} from '@sbom/shared';
import { logger } from '../lib/logger.js';
import { query, queryOne, transaction } from './client.js';

// ---------- Reference data ----------

const CUSTOMERS: {
  key: string;
  name: string;
  email: string | null;
  phone: string | null;
  channel: Channel;
  tier: CustomerTier;
  notes: string;
}[] = [
  {
    key: 'ayesha',
    name: 'Ayesha Khan',
    email: 'ayesha.khan@example.com',
    phone: null,
    channel: 'instagram',
    tier: 'loyal',
    notes: 'Repeat customer, loves pastel designs.',
  },
  {
    key: 'ben',
    name: 'Ben Carter',
    email: 'ben.carter@example.com',
    phone: null,
    channel: 'email',
    tier: 'standard',
    notes: '',
  },
  {
    key: 'bloom',
    name: 'Bloom Café',
    email: 'orders@bloomcafe.example.com',
    phone: '+44 20 7946 0101',
    channel: 'email',
    tier: 'wholesale',
    notes: 'Buys custom stickers for takeaway cups. Contact: Maria Lopez.',
  },
  {
    key: 'priya',
    name: 'Priya Sharma',
    email: null,
    phone: '+44 7700 900123',
    channel: 'whatsapp',
    tier: 'standard',
    notes: '',
  },
  {
    key: 'leo',
    name: 'Leo Martin',
    email: 'leo.martin@example.com',
    phone: '+44 7700 900456',
    channel: 'sms',
    tier: 'standard',
    notes: 'First order.',
  },
  {
    key: 'papertrail',
    name: 'Paper Trail Bookshop',
    email: 'hello@papertrail.example.com',
    phone: '+44 161 496 0202',
    channel: 'email',
    tier: 'wholesale',
    notes: 'Stocks our cards and bookmarks at the till.',
  },
];

const PRODUCTS: {
  sku: string;
  name: string;
  description: string;
  category: string;
  priceCents: number;
  minutesPerUnit: number;
  madeToOrder: boolean;
  onHand: number;
  reorderPoint: number;
}[] = [
  {
    sku: 'STK-PINK',
    name: 'Pink sticker sheet',
    description: 'A5 sheet of pastel pink vinyl stickers',
    category: 'stickers',
    priceCents: 450,
    minutesPerUnit: 20,
    madeToOrder: false,
    onHand: 2,
    reorderPoint: 5,
  },
  {
    sku: 'STK-HOLO',
    name: 'Holographic sticker sheet',
    description: 'A5 sheet of holographic stickers',
    category: 'stickers',
    priceCents: 650,
    minutesPerUnit: 25,
    madeToOrder: false,
    onHand: 15,
    reorderPoint: 5,
  },
  {
    sku: 'STK-CUSTOM',
    name: 'Custom die-cut stickers (pack of 10)',
    description: 'Printed from customer artwork and die-cut to shape',
    category: 'stickers',
    priceCents: 1200,
    minutesPerUnit: 45,
    madeToOrder: true,
    onHand: 0,
    reorderPoint: 0,
  },
  {
    sku: 'PLAN-WEEKLY',
    name: 'Weekly planner sticker kit',
    description: '4 sheets of functional planner stickers',
    category: 'stickers',
    priceCents: 1100,
    minutesPerUnit: 35,
    madeToOrder: false,
    onHand: 8,
    reorderPoint: 8,
  },
  {
    sku: 'CARD-THANK',
    name: 'Thank-you cards (pack of 5)',
    description: 'Printed kraft thank-you cards with envelopes',
    category: 'cards',
    priceCents: 800,
    minutesPerUnit: 15,
    madeToOrder: false,
    onHand: 30,
    reorderPoint: 10,
  },
  {
    sku: 'BKMK-FLORAL',
    name: 'Floral bookmark',
    description: 'Laminated floral bookmark with tassel',
    category: 'bookmarks',
    priceCents: 350,
    minutesPerUnit: 10,
    madeToOrder: false,
    onHand: 40,
    reorderPoint: 10,
  },
  {
    sku: 'WASHI-PASTEL',
    name: 'Pastel washi tape set',
    description: 'Set of 5 pastel washi tapes (bought in from our supplier)',
    category: 'tape',
    priceCents: 950,
    minutesPerUnit: 0,
    madeToOrder: false,
    onHand: 0,
    reorderPoint: 6,
  },
  {
    sku: 'WASHI-GOLD',
    name: 'Gold foil washi tape set',
    description: 'Set of 3 gold foil washi tapes (bought in from our supplier)',
    category: 'tape',
    priceCents: 1050,
    minutesPerUnit: 0,
    madeToOrder: false,
    onHand: 9,
    reorderPoint: 3,
  },
  {
    sku: 'PRINT-A5',
    name: 'A5 illustrated art print',
    description: 'Giclée print on 300gsm paper',
    category: 'prints',
    priceCents: 1500,
    minutesPerUnit: 20,
    madeToOrder: false,
    onHand: 12,
    reorderPoint: 4,
  },
];

const PRICING_RULES: {
  name: string;
  description: string;
  type: PricingRuleType;
  sku?: string;
  tier?: CustomerTier;
  minQuantity?: number;
  maxDays?: number;
  percent: number;
}[] = [
  {
    name: 'Volume 3+',
    description: '5% off when ordering 3 or more units of a product',
    type: 'volume_discount',
    minQuantity: 3,
    percent: 5,
  },
  {
    name: 'Volume 10+',
    description: '10% off when ordering 10 or more units of a product',
    type: 'volume_discount',
    minQuantity: 10,
    percent: 10,
  },
  {
    name: 'Volume 25+',
    description: '15% off when ordering 25 or more units of a product',
    type: 'volume_discount',
    minQuantity: 25,
    percent: 15,
  },
  {
    name: 'Card bundle',
    description: '12% off 5 or more packs of thank-you cards',
    type: 'volume_discount',
    sku: 'CARD-THANK',
    minQuantity: 5,
    percent: 12,
  },
  {
    name: 'Loyal customer',
    description: 'Extra 5% off for loyal customers',
    type: 'customer_tier_discount',
    tier: 'loyal',
    percent: 5,
  },
  {
    name: 'Wholesale',
    description: '15% off for wholesale accounts',
    type: 'customer_tier_discount',
    tier: 'wholesale',
    percent: 15,
  },
  {
    name: 'Rush order',
    description: '20% surcharge when the deadline is 2 days away or less',
    type: 'rush_surcharge',
    maxDays: 2,
    percent: 20,
  },
  {
    name: 'Discount cap',
    description: 'Combined discounts never exceed 20%',
    type: 'max_discount',
    percent: 20,
  },
];

const CAPACITY_DAYS = 28;
const WEEKDAY_MINUTES = 240;
const SATURDAY_MINUTES = 120;

// ---------- Date helpers (local business dates) ----------

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Offset (in days from today) of the first full weekday (Mon-Fri) on or after `fromOffset`. */
function weekdayOffset(fromOffset: number): number {
  let offset = fromOffset;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    offset++;
  }
  return offset;
}

// ---------- Sample orders ----------

interface SampleOrder {
  customer: string;
  status: OrderStatus;
  /** Path of statuses after 'received', each with how many hours after creation it happened. */
  path: { to: OrderStatus; hoursLater: number; actor: StatusActor; note?: string }[];
  createdDaysAgo: number;
  requestedDeadline: number | null;
  promisedDate: number | null;
  items: { sku: string; quantity: number }[];
  discountPercent: number;
  inbound: string;
  draftReply: string | null;
  finalReply: string | null;
  notes?: string;
}

const APPROVED_PATH: SampleOrder['path'] = [
  { to: 'processing', hoursLater: 0.01, actor: 'system', note: 'Agent workflow started' },
  { to: 'awaiting_approval', hoursLater: 0.02, actor: 'agent', note: 'Quote and reply drafted' },
  { to: 'confirmed', hoursLater: 1, actor: 'human', note: 'Approved by owner' },
];

const SAMPLE_ORDERS: SampleOrder[] = [
  {
    customer: 'ayesha',
    status: 'completed',
    createdDaysAgo: 12,
    requestedDeadline: -7,
    promisedDate: -8,
    items: [{ sku: 'BKMK-FLORAL', quantity: 6 }],
    discountPercent: 10, // volume 3+ (5%) + loyal (5%)
    inbound:
      'Hi! Could I get 6 of the floral bookmarks for my book club? Needed within a week ideally 🌸',
    draftReply: null,
    finalReply:
      'Hi Ayesha! Six floral bookmarks are ready for you. As a loyal customer you get 10% off, so the total is $18.90. Thank you!',
    path: [
      ...APPROVED_PATH,
      { to: 'in_production', hoursLater: 20, actor: 'human' },
      { to: 'ready', hoursLater: 30, actor: 'human' },
      { to: 'completed', hoursLater: 50, actor: 'human', note: 'Collected in store' },
    ],
  },
  {
    customer: 'bloom',
    status: 'in_production',
    createdDaysAgo: 2,
    requestedDeadline: 4,
    promisedDate: 3,
    items: [{ sku: 'STK-CUSTOM', quantity: 3 }],
    discountPercent: 20, // wholesale (15%) + volume 3+ (5%), at the cap
    inbound:
      'Hello, we need 3 packs of custom die-cut stickers with our new cup logo (attached). Can you do them for the weekend?',
    draftReply: null,
    finalReply:
      'Hi Maria, happy to help! 3 packs of custom die-cut stickers come to $28.80 with your wholesale discount. They will be ready in 3 days.',
    path: [...APPROVED_PATH, { to: 'in_production', hoursLater: 24, actor: 'human' }],
  },
  {
    customer: 'papertrail',
    status: 'confirmed',
    createdDaysAgo: 1,
    requestedDeadline: 6,
    promisedDate: 5,
    items: [{ sku: 'CARD-THANK', quantity: 10 }],
    discountPercent: 20, // card bundle (12%) + wholesale (15%) = 27%, capped at 20%
    inbound:
      'Could we restock 10 packs of the kraft thank-you cards for the shop? Next week is fine.',
    draftReply: null,
    finalReply:
      'Hi Paper Trail team! 10 packs of thank-you cards are reserved for you at $64.00 (20% wholesale discount). Ready by the end of the week.',
    path: APPROVED_PATH,
  },
  {
    customer: 'leo',
    status: 'awaiting_approval',
    createdDaysAgo: 0,
    requestedDeadline: 3,
    promisedDate: null,
    items: [{ sku: 'STK-HOLO', quantity: 2 }],
    discountPercent: 0,
    inbound:
      'hey do u have the holographic sticker sheets? want 2, need them in 3 days if possible',
    draftReply:
      'Hi Leo! Yes, we have holographic sticker sheets in stock. Your order of 2 sheets is confirmed: the total is $13.00 and it will be ready within 3 days. Thanks for ordering! Petal & Ink Studio',
    finalReply: null,
    path: APPROVED_PATH.slice(0, 2),
  },
  {
    customer: 'priya',
    status: 'needs_info',
    createdDaysAgo: 0,
    requestedDeadline: null,
    promisedDate: null,
    items: [],
    discountPercent: 0,
    inbound: 'Do you have stickers?',
    draftReply:
      'Hi Priya! We do: pink, holographic, planner and custom die-cut stickers. Which design would you like, how many, and when do you need them?',
    finalReply: null,
    notes: 'No product or quantity given.',
    path: [
      { to: 'processing', hoursLater: 0.01, actor: 'system', note: 'Agent workflow started' },
      { to: 'needs_info', hoursLater: 0.02, actor: 'agent', note: 'Missing product and quantity' },
    ],
  },
];

// ---------- Seeding ----------

const DATA_TABLES = [
  'stock_receipts',
  'approval_requests',
  'production_bookings',
  'agent_runs',
  'messages',
  'order_status_history',
  'order_items',
  'orders',
  'pricing_rules',
  'production_capacity',
  'inventory',
  'products',
  'customers',
];

/** True when there is no catalogue yet (fresh database). */
export async function isDatabaseEmpty(): Promise<boolean> {
  const row = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM products');
  return (row?.n ?? 0) === 0;
}

/** Wipe all business data and insert the demo data set. */
export async function seedDatabase(): Promise<void> {
  await transaction(async (db) => {
    await db.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    const customerIds = new Map<string, number>();
    for (const c of CUSTOMERS) {
      const row = await queryOne<{ id: number }>(
        `INSERT INTO customers (name, email, phone, channel, tier, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [c.name, c.email, c.phone, c.channel, c.tier, c.notes],
        db,
      );
      customerIds.set(c.key, row!.id);
    }

    const products = new Map<string, { id: number; price: number; minutes: number }>();
    for (const p of PRODUCTS) {
      const row = await queryOne<{ id: number }>(
        `INSERT INTO products (sku, name, description, category, unit_price_cents,
                               production_minutes_per_unit, made_to_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [p.sku, p.name, p.description, p.category, p.priceCents, p.minutesPerUnit, p.madeToOrder],
        db,
      );
      await query(
        'INSERT INTO inventory (product_id, on_hand, reorder_point) VALUES ($1, $2, $3)',
        [row!.id, p.onHand, p.reorderPoint],
        db,
      );
      products.set(p.sku, { id: row!.id, price: p.priceCents, minutes: p.minutesPerUnit });
    }

    for (const r of PRICING_RULES) {
      await query(
        `INSERT INTO pricing_rules (name, description, rule_type, product_id, customer_tier,
                                    min_quantity, max_days_until_deadline, percent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          r.name,
          r.description,
          r.type,
          r.sku ? products.get(r.sku)!.id : null,
          r.tier ?? null,
          r.minQuantity ?? null,
          r.maxDays ?? null,
          r.percent,
        ],
        db,
      );
    }

    for (let i = 0; i < CAPACITY_DAYS; i++) {
      const day = new Date();
      day.setDate(day.getDate() + i);
      const dow = day.getDay();
      const minutes = dow === 0 ? 0 : dow === 6 ? SATURDAY_MINUTES : WEEKDAY_MINUTES;
      await query(
        'INSERT INTO production_capacity (day, capacity_minutes) VALUES ($1, $2)',
        [isoDay(i), minutes],
        db,
      );
    }

    for (const o of SAMPLE_ORDERS) await insertSampleOrder(db, o, customerIds, products);
  });

  const counts = await query<{ tbl: string; n: number }>(
    DATA_TABLES.map((t) => `SELECT '${t}' AS tbl, COUNT(*) AS n FROM ${t}`).join(' UNION ALL '),
  );
  logger.info('demo data seeded', Object.fromEntries(counts.map((c) => [c.tbl, c.n])));
}

async function insertSampleOrder(
  db: pg.PoolClient,
  o: SampleOrder,
  customerIds: Map<string, number>,
  products: Map<string, { id: number; price: number; minutes: number }>,
): Promise<void> {
  const customerId = customerIds.get(o.customer)!;
  const subtotal = o.items.reduce((sum, i) => sum + products.get(i.sku)!.price * i.quantity, 0);
  const total = Math.round((subtotal * (100 - o.discountPercent)) / 100);
  const hasQuote = o.items.length > 0;
  // created_at = now - createdDaysAgo; each status change is `hoursLater` after that.
  const createdAt = `now() - interval '${o.createdDaysAgo} days' - interval '2 hours'`;
  const lastChange = o.path.at(-1)?.hoursLater ?? 0;

  const order = await queryOne<{ id: number }>(
    `INSERT INTO orders (customer_id, status, requested_deadline, promised_date, subtotal_cents,
                         discount_percent, total_cents, draft_reply, final_reply, notes,
                         created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             ${createdAt}, ${createdAt} + make_interval(secs => $11))
     RETURNING id`,
    [
      customerId,
      o.status,
      o.requestedDeadline === null ? null : isoDay(o.requestedDeadline),
      o.promisedDate === null ? null : isoDay(o.promisedDate),
      hasQuote ? subtotal : null,
      o.discountPercent,
      hasQuote ? total : null,
      o.draftReply,
      o.finalReply,
      o.notes ?? '',
      lastChange * 3600,
    ],
    db,
  );
  const orderId = order!.id;

  for (const i of o.items) {
    const p = products.get(i.sku)!;
    await query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4)`,
      [orderId, p.id, i.quantity, p.price],
      db,
    );
  }

  const channel = CUSTOMERS.find((c) => c.key === o.customer)!.channel;
  if (o.status === 'awaiting_approval' || o.status === 'needs_info') {
    await insertSampleApproval(db, o, orderId, customerId, products);
  }
  await query(
    `INSERT INTO messages (customer_id, order_id, direction, channel, body, created_at)
     VALUES ($1, $2, 'inbound', $3, $4, ${createdAt})`,
    [customerId, orderId, channel, o.inbound],
    db,
  );
  if (o.finalReply) {
    const approvedAt = o.path.find((s) => s.to === 'confirmed')?.hoursLater ?? 0;
    await query(
      `INSERT INTO messages (customer_id, order_id, direction, channel, body, created_at)
       VALUES ($1, $2, 'outbound', $3, $4, ${createdAt} + make_interval(secs => $5))`,
      [customerId, orderId, channel, o.finalReply, approvedAt * 3600],
      db,
    );
  }

  // Status history: received, then each step of the path.
  const steps = [
    {
      to: 'received' as OrderStatus,
      hoursLater: 0,
      actor: 'system' as StatusActor,
      note: 'Order created',
    },
    ...o.path,
  ];
  let from: OrderStatus | null = null;
  for (const s of steps) {
    await query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, actor, note, created_at)
       VALUES ($1, $2, $3, $4, $5, ${createdAt} + make_interval(secs => $6))`,
      [orderId, from, s.to, s.actor, s.note ?? null, s.hoursLater * 3600],
      db,
    );
    from = s.to;
  }

  // Keep inventory and capacity consistent with the order's state, and record the allocations
  // (order_items.reserved_quantity, production_bookings) so cancelling releases exactly these.
  // Completed orders already left the shelf: the seeded on_hand is the post-sale level.
  const holdsResources = ['confirmed', 'in_production', 'ready'].includes(o.status);
  for (const i of o.items) {
    if (!holdsResources) continue;
    const p = products.get(i.sku)!;
    const isMadeToOrder = PRODUCTS.find((x) => x.sku === i.sku)!.madeToOrder;
    if (isMadeToOrder) {
      // Book the production time on the next full weekday (Saturdays are half days).
      const day = isoDay(weekdayOffset(1));
      const minutes = p.minutes * i.quantity;
      await query(
        'UPDATE production_capacity SET booked_minutes = booked_minutes + $2 WHERE day = $1',
        [day, minutes],
        db,
      );
      await query(
        'INSERT INTO production_bookings (order_id, day, minutes) VALUES ($1, $2, $3)',
        [orderId, day, minutes],
        db,
      );
    } else {
      await query(
        'UPDATE inventory SET reserved = reserved + $2 WHERE product_id = $1',
        [p.id, i.quantity],
        db,
      );
      await query(
        'UPDATE order_items SET reserved_quantity = $3 WHERE order_id = $1 AND product_id = $2',
        [orderId, p.id, i.quantity],
        db,
      );
    }
  }
}

/**
 * Open approval requests for the sample orders waiting on a person, shaped like the ones the agent
 * workflow produces (see workflow/approvalPacket.ts).
 */
async function insertSampleApproval(
  db: pg.PoolClient,
  o: SampleOrder,
  orderId: number,
  customerId: number,
  products: Map<string, { id: number; price: number; minutes: number }>,
): Promise<void> {
  const c = CUSTOMERS.find((x) => x.key === o.customer)!;
  const today = isoDay(0);
  const lines = o.items.map((i) => {
    const p = products.get(i.sku)!;
    const seed = PRODUCTS.find((x) => x.sku === i.sku)!;
    return { ...i, productId: p.id, name: seed.name, price: p.price, onHand: seed.onHand };
  });
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const ready = o.status === 'awaiting_approval';

  const packet: ApprovalPacket = {
    orderId,
    runId: '00000000-0000-0000-0000-000000000000',
    stopReason: ready ? 'human_approval_required' : 'missing_info',
    customer: {
      id: customerId,
      name: c.name,
      tier: c.tier,
      channel: c.channel,
      email: c.email,
      phone: c.phone,
      isNew: false,
    },
    request: {
      message: o.inbound,
      items: lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
      })),
      unresolved: ready ? [] : [{ asked: 'stickers', reason: 'ambiguous_product' }],
      requestedDeadline: o.requestedDeadline === null ? null : isoDay(o.requestedDeadline),
      customization: null,
      otherRequests: null,
      discountRequested: false,
    },
    pricing: ready
      ? {
          subtotalCents: subtotal,
          discountCents: 0,
          surchargeCents: 0,
          totalCents: subtotal,
          discountPercent: 0,
          appliedRules: [],
          discountDecision: 'not_requested',
          explanation: 'Below the 3-unit volume threshold, so list price applies.',
        }
      : null,
    inventory: ready
      ? {
          fulfillable: true,
          allInStock: true,
          lines: lines.map((l) => ({
            sku: l.sku,
            requested: l.quantity,
            fromStock: l.quantity,
            toProduce: 0,
            unfulfillable: 0,
            availableAfter: l.onHand - l.quantity,
            belowReorderPointAfter: false,
          })),
          summary: 'Everything ships from stock.',
        }
      : null,
    production: ready
      ? {
          feasible: true,
          needsProduction: false,
          estimatedCompletionDate: today,
          requestedDeadline: o.requestedDeadline === null ? null : isoDay(o.requestedDeadline),
          meetsDeadline: true,
          slackDays: o.requestedDeadline,
          earliestPossibleDate: today,
          summary: 'Everything ships from stock and can be ready today.',
        }
      : null,
    response: { draftReply: o.draftReply },
    verification: [],
    routing: [],
    offers: [],
    warnings: ready
      ? []
      : [
          {
            code: 'missing_info',
            severity: 'critical',
            message:
              'The request is incomplete; the draft reply asks the customer for the missing details.',
          },
        ],
    recommendedAction: ready ? 'approve' : 'request_info',
    recommendationReason: ready
      ? 'Priced, in stock or schedulable, and on time. Safe to approve.'
      : 'Send the clarifying reply and wait for the customer before quoting.',
  };

  await query(
    `INSERT INTO approval_requests
       (order_id, run_id, packet, recommended_action, recommendation_reason, warning_count,
        draft_reply, created_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, now() - interval '${o.createdDaysAgo} days' - interval '2 hours'
             + make_interval(secs => $7))`,
    [
      orderId,
      JSON.stringify(packet),
      packet.recommendedAction,
      packet.recommendationReason,
      packet.warnings.filter((w) => w.severity !== 'info').length,
      o.draftReply,
      (o.path.at(-1)?.hoursLater ?? 0) * 3600,
    ],
    db,
  );
}
