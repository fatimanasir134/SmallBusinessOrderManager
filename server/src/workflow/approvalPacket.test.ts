import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CustomerDto } from '@sbom/shared';
import type { InventoryOutput } from '../agents/inventory.js';
import type { PricingOutput } from '../agents/pricing.js';
import type { ProductionOutput } from '../agents/production.js';
import type { UnderstandingOutput } from '../agents/understanding.js';
import { assessInventory } from '../domain/inventory.js';
import { calculatePrice } from '../domain/pricing.js';
import { estimateCompletion } from '../domain/production.js';
import { PRODUCTS, RULES, product } from '../test/fixtures.js';
import { type PacketInput, buildApprovalPacket } from './approvalPacket.js';

const TODAY = '2026-10-01';
const leo: CustomerDto = {
  id: 5,
  name: 'Leo Martin',
  email: 'leo@example.com',
  phone: null,
  channel: 'sms',
  tier: 'standard',
  notes: '',
  createdAt: '2026-10-01T00:00:00.000Z',
};
const DAYS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
  day: `2026-10-0${n + 1}`,
  capacityMinutes: 240,
  bookedMinutes: 0,
}));

/** Real pricing, stock, and scheduling results for an order, as the agents would pass them on. */
function analysed(
  sku: string,
  quantity: number,
  opts: { deadline?: string; customization?: string; discountRequested?: boolean } = {},
): PacketInput {
  const p = product(sku);
  const items = [{ productId: p.id, quantity }];
  const deadline = opts.deadline ?? null;
  const quote = calculatePrice({
    lines: [{ ...items[0]!, unitPriceCents: p.unitPriceCents }],
    rules: RULES,
    customerTier: 'standard',
    requestedDeadline: deadline,
    today: TODAY,
    discountRequested: opts.discountRequested,
  });
  const assessment = assessInventory(items, PRODUCTS);
  const estimate = estimateCompletion(assessment.totalProductionMinutes, DAYS, TODAY, deadline);
  const extraction = {
    customer: { name: null, email: null, phone: null },
    items: [
      { productId: p.id, sku, productName: p.name, quantity, matchedFrom: sku, matchScore: 1 },
    ],
    unresolvedItems: [],
    requestedDeadline: deadline,
    deadlineSource: deadline ? 'model' : null,
    deadlineText: null,
    discountRequested: opts.discountRequested ?? false,
    customization: opts.customization ?? null,
    otherRequests: null,
    missingInfo: [],
    isComplete: true,
  } as unknown as UnderstandingOutput;
  const feasible = estimate.estimatedCompletionDate !== null && estimate.meetsDeadline !== false;
  return {
    orderId: 42,
    runId: 'run-1',
    stopReason: feasible ? 'human_approval_required' : 'deadline_impossible',
    message: 'msg',
    channel: 'sms',
    customer: leo,
    customerIsNew: false,
    extraction,
    pricing: {
      quote: { ...quote, customerTier: 'standard' },
      discountDecision: quote.discountCents
        ? 'applied'
        : opts.discountRequested
          ? 'not_eligible'
          : 'not_requested',
      explanation: 'From the rules.',
    } as PricingOutput,
    inventory: { assessment, summary: 'ok' } as InventoryOutput,
    production: {
      estimate: { ...estimate, earliestPossibleDate: estimate.estimatedCompletionDate },
      feasible,
      summary: estimate.summary,
    } as ProductionOutput,
    draftReply: 'Hi Leo! ...',
    steps: [],
  };
}

describe('buildApprovalPacket', () => {
  it('collects everything the person needs to decide', () => {
    const p = buildApprovalPacket(analysed('STK-PINK', 3, { deadline: '2026-10-09' }));
    assert.equal(p.customer.name, 'Leo Martin');
    assert.deepEqual(
      p.request.items.map((i) => [i.sku, i.quantity]),
      [['STK-PINK', 3]],
    );
    assert.equal(p.pricing!.totalCents, 1282);
    assert.deepEqual(p.pricing!.appliedRules, ['Volume 3+']);
    assert.deepEqual(
      p.inventory!.lines.map((l) => [l.fromStock, l.toProduce]),
      [[2, 1]],
    );
    assert.equal(p.production!.meetsDeadline, true);
    assert.equal(p.response.draftReply, 'Hi Leo! ...');
  });

  it('recommends approving a clean order, with informational notes only', () => {
    const p = buildApprovalPacket(analysed('STK-PINK', 3, { deadline: '2026-10-09' }));
    assert.equal(p.recommendedAction, 'approve');
    assert.deepEqual(p.warnings.map((w) => `${w.severity}:${w.code}`).sort(), [
      'info:low_stock',
      'info:needs_production',
    ]);
  });

  it('asks for review when there are real warnings', () => {
    const custom = buildApprovalPacket(analysed('STK-HOLO', 2, { customization: 'add my name' }));
    assert.equal(custom.recommendedAction, 'review');
    assert.ok(custom.warnings.some((w) => w.code === 'customization' && w.severity === 'warning'));

    const tight = buildApprovalPacket(analysed('STK-HOLO', 2, { deadline: TODAY }));
    assert.ok(tight.warnings.some((w) => w.code === 'tight_deadline'));
    assert.ok(tight.warnings.some((w) => w.code === 'rush_surcharge'));
    assert.equal(tight.recommendedAction, 'review');
  });

  it('flags agents the backend had to overrule', () => {
    const input = analysed('STK-HOLO', 2);
    input.steps = [
      {
        agent: 'pricing',
        verification: 'corrected',
        discrepancies: ['totalCents: agent said 850, tools say 1300'],
      },
    ];
    const p = buildApprovalPacket(input);
    assert.equal(p.verification.length, 1);
    assert.ok(p.warnings.some((w) => w.code === 'agent_corrected' && w.severity === 'warning'));
    assert.equal(p.recommendedAction, 'review');
  });

  it('turns each stop reason into a recommendation', () => {
    const late = buildApprovalPacket(analysed('STK-CUSTOM', 30, { deadline: '2026-10-02' }));
    assert.equal(late.stopReason, 'deadline_impossible');
    assert.equal(late.recommendedAction, 'review');
    assert.match(late.recommendationReason, /earliest possible/);

    for (const [stopReason, action] of [
      ['missing_info', 'request_info'],
      ['unknown_product', 'request_info'],
      ['insufficient_inventory', 'reject'], // nothing offered in this fixture
      ['unverified_reply', 'review'],
    ] as const) {
      const p = buildApprovalPacket({ ...analysed('STK-HOLO', 1), stopReason });
      assert.equal(p.recommendedAction, action, stopReason);
      assert.ok(
        p.warnings.some((w) => w.severity === 'critical'),
        stopReason,
      );
    }
  });

  it('warns when there is no customer to reply to', () => {
    const p = buildApprovalPacket({ ...analysed('STK-HOLO', 1), customer: undefined });
    assert.ok(p.warnings.some((w) => w.code === 'unknown_customer'));
  });
});
