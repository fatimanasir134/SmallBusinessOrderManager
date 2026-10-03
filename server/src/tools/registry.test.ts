/** Argument validation and Gemini declarations. No database or Gemini calls needed. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOOLS, executeTool, geminiFunctionDeclarations } from './registry.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { actor: 'agent', today: '2026-10-01' };

async function expectInvalid(tool: string, args: unknown, pattern: RegExp) {
  const r = await executeTool(tool, args, ctx);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'INVALID_ARGUMENTS');
  assert.match(!r.ok ? r.error.message : '', pattern);
}

describe('executeTool validation', () => {
  it('rejects unknown tools without throwing', async () => {
    const r = await executeTool('deleteEverything', {}, ctx);
    assert.equal(!r.ok && r.error.code, 'UNKNOWN_TOOL');
  });

  it('rejects empty, negative, fractional, and oversized quantities', async () => {
    await expectInvalid('calculateOrderPrice', { items: [] }, /items: at least one item/);
    await expectInvalid('checkInventory', { items: [{ productId: 1, quantity: -1 }] }, /quantity/);
    await expectInvalid('checkInventory', { items: [{ productId: 1, quantity: 1.5 }] }, /quantity/);
    await expectInvalid(
      'checkInventory',
      { items: [{ productId: 1, quantity: 5000 }] },
      /quantity/,
    );
  });

  it('rejects impossible dates', async () => {
    await expectInvalid(
      'calculateEstimatedCompletion',
      { items: [{ productId: 1, quantity: 1 }], requestedDeadline: '2026-02-30' },
      /real calendar date/,
    );
  });

  it('requires at least one lookup key', async () => {
    await expectInvalid('getProductInformation', {}, /provide productId, sku, or query/);
    await expectInvalid('getCustomerInformation', {}, /provide customerId, email, phone, or name/);
    await expectInvalid(
      'createOrder',
      { items: [{ productId: 1, quantity: 1 }] },
      /customerId or newCustomer/,
    );
  });

  it('rejects unknown statuses and missing order ids', async () => {
    await expectInvalid('updateOrderStatus', { orderId: 1, status: 'shipped' }, /status/);
    await expectInvalid('updateOrderStatus', { status: 'confirmed' }, /orderId/);
  });

  it('rejects an empty message for extraction', async () => {
    await expectInvalid('extractOrderInformation', { message: '   ' }, /message is empty/);
  });
});

describe('geminiFunctionDeclarations', () => {
  it('declares every tool with JSON schemas built from the zod inputs', () => {
    const decls = geminiFunctionDeclarations();
    assert.equal(decls.length, 10);
    assert.deepEqual(
      decls.map((d) => d.name),
      TOOLS.map((t) => t.name),
    );
    for (const d of decls) {
      const schema = d.parametersJsonSchema as Record<string, unknown>;
      assert.equal(schema.type, 'object', d.name);
      assert.equal('$schema' in schema, false);
      assert.ok(d.description && d.description.length > 40, `${d.name} needs a useful description`);
    }
  });

  it('can limit the declarations to the tools an agent needs', () => {
    const decls = geminiFunctionDeclarations(['checkInventory', 'getProductInformation']);
    assert.deepEqual(
      decls.map((d) => d.name),
      ['checkInventory', 'getProductInformation'],
    );
  });
});
