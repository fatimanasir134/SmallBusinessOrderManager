/**
 * Runs the tools against a real PostgreSQL test database (`<DATABASE_URL name>_test`, created
 * automatically and re-seeded before each test). Requires Postgres to be running
 * (`npm run db:start`); otherwise these tests are skipped.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { closeDb, query, queryOne } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedDatabase } from '../db/seed.js';
import { addDays, todayIso } from '../domain/dates.js';
import { getProductBySku } from '../repositories/products.js';
import { SKIP_WITHOUT_DB, ensureTestDatabase } from '../test/db.js';
import { executeTool } from './registry.js';
import type { ToolContext, ToolResult } from './types.js';

const TODAY = todayIso();
const agent: ToolContext = { actor: 'agent', today: TODAY };
const human: ToolContext = { actor: 'human', today: TODAY };

/** Unwrap a successful result, or fail the test with the tool's error. */
function ok<T = any>(r: ToolResult): T {
  if (!r.ok) assert.fail(`${r.tool} failed: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}

function err(r: ToolResult) {
  assert.equal(r.ok, false, `${r.tool} should have failed`);
  return (r as Extract<ToolResult, { ok: false }>).error;
}

const available = async (sku: string) => (await getProductBySku(sku))!.inventory;
const pinkId = async () => (await getProductBySku('STK-PINK'))!.id;

const dbAvailable = await ensureTestDatabase();

describe('business tools against PostgreSQL', { skip: !dbAvailable && SKIP_WITHOUT_DB }, () => {
  before(async () => {
    await runMigrations();
  });
  beforeEach(async () => {
    await seedDatabase();
  });
  after(async () => {
    await closeDb();
  });

  it('getProductInformation matches free text and includes stock and discounts', async () => {
    const r = ok(
      await executeTool('getProductInformation', { query: 'pink sticker sheets' }, agent),
    );
    assert.equal(r.found, true);
    assert.equal(r.product.sku, 'STK-PINK');
    assert.equal(r.product.inventory.available, 2);
    assert.ok(r.product.volumeDiscounts.some((d: any) => d.minQuantity === 3));

    const ambiguous = ok(await executeTool('getProductInformation', { query: 'stickers' }, agent));
    assert.equal(ambiguous.found, false);
    assert.ok(ambiguous.candidates.length >= 2);
  });

  it('getCustomerInformation finds by email or phone and reports tier and history', async () => {
    const r = ok(
      await executeTool('getCustomerInformation', { email: 'AYESHA.KHAN@example.com' }, agent),
    );
    assert.equal(r.customer.name, 'Ayesha Khan');
    assert.equal(r.customer.tier, 'loyal');
    assert.equal(r.tierDiscountPercent, 5);
    assert.equal(r.stats.completedOrders, 1);
    assert.equal(r.stats.lifetimeSpendCents, 1890);

    const byPhone = ok(
      await executeTool('getCustomerInformation', { phone: '07700 900123' }, agent),
    );
    assert.equal(byPhone.customer.name, 'Priya Sharma');

    const unknown = ok(
      await executeTool('getCustomerInformation', { email: 'new@example.com' }, agent),
    );
    assert.equal(unknown.found, false);
  });

  it('calculateOrderPrice prices the demo order and applies the customer tier', async () => {
    const items = [{ productId: await pinkId(), quantity: 3 }];
    const standard = ok(await executeTool('calculateOrderPrice', { items }, agent));
    assert.equal(standard.totalCents, 1282);

    const loyal = ok(await executeTool('calculateOrderPrice', { items, customerId: 1 }, agent));
    assert.equal(loyal.customerTier, 'loyal');
    assert.equal(loyal.totalCents, 1350 - 135);

    const e = err(
      await executeTool('calculateOrderPrice', { items: [{ productId: 999, quantity: 1 }] }, agent),
    );
    assert.equal(e.code, 'BAD_REQUEST');
    assert.match(e.message, /Unknown product id/);
  });

  it('checkInventory and calculateEstimatedCompletion use live stock and capacity', async () => {
    const items = [{ productId: await pinkId(), quantity: 3 }];
    const stock = ok(await executeTool('checkInventory', { items }, agent));
    assert.equal(stock.lines[0].fromStock, 2);
    assert.equal(stock.lines[0].toProduce, 1);

    const est = ok(
      await executeTool(
        'calculateEstimatedCompletion',
        { items, requestedDeadline: addDays(TODAY, 7) },
        agent,
      ),
    );
    assert.equal(est.needsProduction, true);
    assert.equal(est.meetsDeadline, true);

    const cap = ok(await executeTool('checkProductionCapacity', { requiredMinutes: 20 }, agent));
    assert.equal(cap.fitsInHorizon, true);
    assert.ok(cap.freeMinutesByDay.length > 0);

    const past = err(
      await executeTool(
        'checkProductionCapacity',
        { requiredMinutes: 20, deadline: addDays(TODAY, -1) },
        agent,
      ),
    );
    assert.match(past.message, /in the past/);
  });

  it('createOrder prices on the server, stores the message, and reuses existing customers', async () => {
    const args = {
      newCustomer: { name: 'Sam Lee', email: 'sam.lee@example.com' },
      items: [{ productId: await pinkId(), quantity: 3 }],
      requestedDeadline: addDays(TODAY, 7),
      discountRequested: true,
      channel: 'instagram',
      sourceMessage: 'I need 3 pink sticker sheets by Friday. Can I get a discount? 💖',
    };
    const first = ok(await executeTool('createOrder', args, agent));
    assert.equal(first.status, 'received');
    assert.equal(first.customer.created, true);
    assert.equal(first.quote.totalCents, 1282);

    const order = await queryOne<{ total_cents: number; status: string }>(
      'SELECT total_cents, status FROM orders WHERE id = $1',
      [first.orderId],
    );
    assert.deepEqual(order, { total_cents: 1282, status: 'received' });
    const msgs = await query<{ body: string }>('SELECT body FROM messages WHERE order_id = $1', [
      first.orderId,
    ]);
    assert.match(msgs[0]!.body, /💖/);

    const second = ok(
      await executeTool(
        'createOrder',
        { ...args, newCustomer: { name: 'Sam', email: 'SAM.LEE@example.com' } },
        agent,
      ),
    );
    assert.equal(second.customer.created, false);
    assert.equal(second.customer.id, first.customer.id);
  });

  it('createOrder rejects bad input without writing anything', async () => {
    const before = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM orders');
    const past = err(
      await executeTool(
        'createOrder',
        {
          customerId: 2,
          items: [{ productId: await pinkId(), quantity: 1 }],
          requestedDeadline: addDays(TODAY, -3),
        },
        agent,
      ),
    );
    assert.equal(past.code, 'BAD_REQUEST');
    const unknownCustomer = err(
      await executeTool(
        'createOrder',
        { customerId: 999, items: [{ productId: 1, quantity: 1 }] },
        agent,
      ),
    );
    assert.equal(unknownCustomer.code, 'NOT_FOUND');
    const afterCount = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM orders');
    assert.equal(afterCount!.n, before!.n);
  });

  it('agents cannot approve; a human approval reserves stock and books production', async () => {
    const created = ok(
      await executeTool(
        'createOrder',
        { customerId: 2, items: [{ productId: await pinkId(), quantity: 3 }] },
        agent,
      ),
    );
    const id = created.orderId;

    ok(await executeTool('updateOrderStatus', { orderId: id, status: 'processing' }, agent));
    ok(await executeTool('updateOrderStatus', { orderId: id, status: 'awaiting_approval' }, agent));

    const forbidden = err(
      await executeTool('updateOrderStatus', { orderId: id, status: 'confirmed' }, agent),
    );
    assert.equal(forbidden.code, 'FORBIDDEN');
    assert.equal(
      (await available('STK-PINK')).reserved,
      0,
      'nothing reserved by the failed attempt',
    );

    const approved = ok(
      await executeTool(
        'updateOrderStatus',
        { orderId: id, status: 'confirmed', note: 'Looks good' },
        human,
      ),
    );
    assert.deepEqual(approved.effects.reserved, [{ productId: await pinkId(), quantity: 2 }]);
    assert.equal(
      approved.effects.productionBooked.reduce((s: number, b: any) => s + b.minutes, 0),
      20,
    );
    assert.ok(approved.effects.promisedDate >= TODAY);

    const inv = await available('STK-PINK');
    assert.equal(inv.reserved, 2);
    assert.equal(inv.available, 0);

    const history = await query<{ to_status: string; actor: string }>(
      'SELECT to_status, actor FROM order_status_history WHERE order_id = $1 ORDER BY id',
      [id],
    );
    assert.deepEqual(
      history.map((h) => `${h.to_status}:${h.actor}`),
      ['received:agent', 'processing:agent', 'awaiting_approval:agent', 'confirmed:human'],
    );
  });

  it('cancelling a confirmed order releases exactly what it held', async () => {
    const capacityBefore = await queryOne<{ booked: number }>(
      'SELECT SUM(booked_minutes) AS booked FROM production_capacity',
    );
    const created = ok(
      await executeTool(
        'createOrder',
        { customerId: 2, items: [{ productId: await pinkId(), quantity: 3 }] },
        agent,
      ),
    );
    const id = created.orderId;
    for (const status of ['processing', 'awaiting_approval'] as const) {
      ok(await executeTool('updateOrderStatus', { orderId: id, status }, agent));
    }
    ok(await executeTool('updateOrderStatus', { orderId: id, status: 'confirmed' }, human));

    const cancelled = ok(
      await executeTool('updateOrderStatus', { orderId: id, status: 'cancelled' }, human),
    );
    assert.deepEqual(cancelled.effects.released, [{ productId: await pinkId(), quantity: 2 }]);
    assert.equal((await available('STK-PINK')).available, 2);
    const capacityAfter = await queryOne<{ booked: number }>(
      'SELECT SUM(booked_minutes) AS booked FROM production_capacity',
    );
    assert.equal(capacityAfter!.booked, capacityBefore!.booked);
    const bookings = await query('SELECT 1 FROM production_bookings WHERE order_id = $1', [id]);
    assert.equal(bookings.length, 0);
  });

  it('completing an order ships its reserved stock', async () => {
    const created = ok(
      await executeTool(
        'createOrder',
        { customerId: 2, items: [{ productId: await pinkId(), quantity: 1 }] },
        agent,
      ),
    );
    const id = created.orderId;
    for (const status of ['processing', 'awaiting_approval'] as const) {
      ok(await executeTool('updateOrderStatus', { orderId: id, status }, agent));
    }
    for (const status of ['confirmed', 'in_production', 'ready', 'completed'] as const) {
      ok(await executeTool('updateOrderStatus', { orderId: id, status }, human));
    }
    const inv = await available('STK-PINK');
    assert.equal(inv.onHand, 1);
    assert.equal(inv.reserved, 0);
  });

  it('a second approval after stock runs out schedules production instead', async () => {
    const items = [{ productId: await pinkId(), quantity: 2 }];
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) {
      const { orderId } = ok(await executeTool('createOrder', { customerId: 2, items }, agent));
      for (const status of ['processing', 'awaiting_approval'] as const) {
        ok(await executeTool('updateOrderStatus', { orderId, status }, agent));
      }
      ids.push(orderId);
    }
    const first = ok(
      await executeTool('updateOrderStatus', { orderId: ids[0], status: 'confirmed' }, human),
    );
    const second = ok(
      await executeTool('updateOrderStatus', { orderId: ids[1], status: 'confirmed' }, human),
    );
    assert.equal(first.effects.reserved[0].quantity, 2);
    assert.deepEqual(second.effects.reserved, []);
    assert.equal(
      second.effects.productionBooked.reduce((s: number, b: any) => s + b.minutes, 0),
      40,
    );
  });

  it('restockProduct: a person receives stock; it is audited; agents cannot', async () => {
    const pink = (await getProductBySku('STK-PINK'))!;
    assert.equal(pink.inventory.suggestedReorder, 8, 'low stock: 2 available, reorder point 5');

    const r = ok(
      await executeTool(
        'restockProduct',
        { productId: pink.id, quantity: 8, note: 'Supplier delivery #42' },
        human,
      ),
    );
    assert.equal(r.product.inventory.onHand, 10);
    assert.equal(r.product.inventory.available, 10);
    assert.equal(r.product.inventory.lowStock, false);
    const receipts = await query<{
      quantity: number;
      on_hand_after: number;
      note: string;
      received_by: string;
    }>('SELECT quantity, on_hand_after, note, received_by FROM stock_receipts');
    assert.deepEqual(receipts, [
      { quantity: 8, on_hand_after: 10, note: 'Supplier delivery #42', received_by: 'shop owner' },
    ]);

    assert.equal(
      err(await executeTool('restockProduct', { productId: pink.id, quantity: 5 }, agent)).code,
      'FORBIDDEN',
    );
    const custom = (await getProductBySku('STK-CUSTOM'))!;
    assert.equal(
      err(await executeTool('restockProduct', { productId: custom.id, quantity: 5 }, human)).code,
      'BAD_REQUEST',
    );
    assert.equal(
      err(await executeTool('restockProduct', { productId: pink.id, quantity: 0 }, human)).code,
      'INVALID_ARGUMENTS',
    );
    assert.equal(
      err(await executeTool('restockProduct', { productId: 9999, quantity: 1 }, human)).code,
      'NOT_FOUND',
    );
    assert.equal(
      (await query('SELECT 1 FROM stock_receipts')).length,
      1,
      'failed attempts write nothing',
    );
  });

  it('rejects invalid transitions and unknown orders', async () => {
    const invalid = err(
      await executeTool('updateOrderStatus', { orderId: 1, status: 'processing' }, human),
    );
    assert.equal(invalid.code, 'INVALID_TRANSITION'); // order 1 is completed
    const missing = err(
      await executeTool('updateOrderStatus', { orderId: 9999, status: 'cancelled' }, human),
    );
    assert.equal(missing.code, 'NOT_FOUND');
  });
});
