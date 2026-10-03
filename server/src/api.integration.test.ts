/**
 * The HTTP API end to end, against a real app instance and the PostgreSQL test database.
 * Gemini is unconfigured in tests (see test/setup.ts), which also exercises the missing-key path.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from './app.js';
import { closeDb, query } from './db/client.js';
import { checkConsistency } from './db/consistency.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { SKIP_WITHOUT_DB, ensureTestDatabase } from './test/db.js';

const dbAvailable = await ensureTestDatabase();

async function serve(options?: Parameters<typeof createApp>[0]) {
  const server = createApp(options).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const waitUntilSettled = async (call: Awaited<ReturnType<typeof serve>>['call'], id: number) => {
  for (let i = 0; i < 50; i++) {
    const r = await call('GET', `/orders/${id}`);
    if (!['received', 'processing'].includes(r.json.status)) return r.json;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('workflow did not settle');
};

describe('HTTP API', { skip: !dbAvailable && SKIP_WITHOUT_DB }, () => {
  let api: Awaited<ReturnType<typeof serve>>;
  before(async () => {
    await runMigrations();
    api = await serve();
  });
  beforeEach(async () => {
    await seedDatabase();
  });
  after(async () => {
    await api.close();
    await closeDb();
  });

  it('rejects invalid input with clear 4xx errors (never 500)', async () => {
    const cases: [string, string, unknown, number, string][] = [
      ['POST', '/messages', '{"message": ', 400, 'INVALID_BODY'],
      ['POST', '/messages', { message: 'x'.repeat(200_000) }, 413, 'PAYLOAD_TOO_LARGE'],
      ['POST', '/messages', { message: '   ' }, 400, 'VALIDATION_ERROR'],
      ['POST', '/messages', { message: 'hi', customerId: -1 }, 400, 'VALIDATION_ERROR'],
      ['POST', '/messages', { message: 'hi', customerId: 999 }, 404, 'NOT_FOUND'],
      ['GET', '/orders/abc', undefined, 400, 'VALIDATION_ERROR'],
      ['GET', '/orders/99999', undefined, 404, 'NOT_FOUND'],
      ['GET', '/capacity?from=2026-02-30', undefined, 400, 'VALIDATION_ERROR'],
      ['GET', "/orders?status=x';DROP TABLE orders;--", undefined, 400, 'VALIDATION_ERROR'],
      ['POST', '/orders/3/status', { status: 'confirmed' }, 400, 'VALIDATION_ERROR'],
      ['POST', '/orders/4/approve', { reply: 'x'.repeat(3000) }, 400, 'VALIDATION_ERROR'],
      ['GET', '/nope', undefined, 404, 'NOT_FOUND'],
    ];
    for (const [method, path, body, status, code] of cases) {
      const r = await api.call(method, path, body);
      assert.equal(r.status, status, `${method} ${path}`);
      assert.equal(r.json.error.code, code, `${method} ${path}`);
      assert.ok(r.json.error.requestId, 'errors carry a request id');
    }
    const orders = await query<{ n: number }>('SELECT COUNT(*) AS n FROM orders');
    assert.equal(orders[0]!.n, 5, 'no order created by rejected requests');
  });

  it('enforces the order lifecycle over HTTP', async () => {
    assert.equal(
      (await api.call('POST', '/orders/4/status', { status: 'in_production' })).json.error.code,
      'INVALID_TRANSITION',
    );
    assert.equal((await api.call('POST', '/orders/1/reject', {})).status, 409); // completed
    assert.equal((await api.call('POST', '/orders/4/reply', { message: 'hi' })).status, 409); // not paused
    assert.equal((await api.call('POST', '/orders/5/approve', {})).status, 409); // needs info
    const ok = await api.call('POST', '/orders/3/status', { status: 'in_production' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'in_production');
    assert.ok((await checkConsistency()).ok);
  });

  it('a missing Gemini key parks the order for review instead of failing the request', async () => {
    const r = await api.call('POST', '/messages', {
      message: 'I need 3 pink sticker sheets',
      customerId: 2,
    });
    assert.equal(r.status, 202);
    const order = await waitUntilSettled(api.call, r.json.orderId);
    assert.equal(order.status, 'needs_review');
    assert.equal(order.stopReason, 'agent_error');
    assert.match(order.agentRuns[0].error, /Gemini is not configured/);
    assert.equal(order.approval, null);
  });

  it('duplicate submissions return the existing order instead of creating another', async () => {
    const msg = { message: 'Two holographic sheets please', customerId: 2 };
    const first = await api.call('POST', '/messages', msg);
    const second = await api.call('POST', '/messages', {
      ...msg,
      message: '  two HOLOGRAPHIC sheets please ',
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, { orderId: first.json.orderId, duplicate: true });

    // Idempotency keys: the same key always maps to the same order, even with a different body.
    const k1 = await api.call(
      'POST',
      '/messages',
      { message: 'A bookmark', customerId: 1 },
      { 'idempotency-key': 'retry-key-0001' },
    );
    const k2 = await api.call(
      'POST',
      '/messages',
      { message: 'A bookmark!!', customerId: 1 },
      { 'idempotency-key': 'retry-key-0001' },
    );
    assert.equal(k2.json.orderId, k1.json.orderId);
    assert.equal(k2.json.duplicate, true);
    const bad = await api.call(
      'POST',
      '/messages',
      { message: 'x', customerId: 1 },
      { 'idempotency-key': 'bad key!' },
    );
    assert.equal(bad.status, 400);
    await waitUntilSettled(api.call, first.json.orderId);
    await waitUntilSettled(api.call, k1.json.orderId);
  });

  it('concurrent identical submissions create exactly one order', async () => {
    const msg = { message: 'Race: one floral bookmark', customerId: 1 };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api.call('POST', '/messages', msg)),
    );
    const ids = new Set(results.map((r) => r.json.orderId));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    await waitUntilSettled(api.call, [...ids][0]!);
  });

  it('restock over HTTP: receive stock, list receipts, reject bad input', async () => {
    const products = (await api.call('GET', '/products')).json as { id: number; sku: string }[];
    const washi = products.find((p) => p.sku === 'WASHI-PASTEL')!;
    const r = await api.call('POST', `/products/${washi.id}/restock`, {
      quantity: 12,
      note: 'Spring order',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.product.inventory.available, 12);
    const list = await api.call('GET', '/products/receipts');
    assert.equal(list.json[0].sku, 'WASHI-PASTEL');
    assert.equal(list.json[0].quantity, 12);
    assert.equal(
      (await api.call('POST', `/products/${washi.id}/restock`, { quantity: 0 })).status,
      400,
    );
    assert.equal(
      (await api.call('POST', `/products/${washi.id}/restock`, { quantity: 1.5 })).status,
      400,
    );
    assert.equal((await api.call('POST', '/products/9999/restock', { quantity: 1 })).status, 404);
    assert.ok((await checkConsistency()).ok);
  });

  it('sets security headers', async () => {
    const r = await api.call('GET', '/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  it('with API_TOKEN set, changes need the token; reads stay open', async () => {
    const locked = await serve({ apiToken: 'test-token-0123456789' });
    try {
      assert.equal((await locked.call('GET', '/orders')).status, 200);
      const denied = await locked.call('POST', '/orders/4/reject', {});
      assert.equal(denied.status, 401);
      assert.equal(denied.json.error.code, 'UNAUTHORIZED');
      const wrong = await locked.call(
        'POST',
        '/orders/4/reject',
        {},
        { authorization: 'Bearer nope' },
      );
      assert.equal(wrong.status, 401);
      const allowed = await locked.call(
        'POST',
        '/orders/4/reject',
        {},
        { authorization: 'Bearer test-token-0123456789' },
      );
      assert.equal(allowed.status, 200);
    } finally {
      await locked.close();
    }
  });
});
