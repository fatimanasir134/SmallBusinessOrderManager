/**
 * The full multi-agent workflow against PostgreSQL, with a scripted Gemini (see test/fakeGemini.ts).
 * Covers the happy path, every stop condition, approval, and agents that misbehave: the backend
 * must catch lies, skipped tools, invented prices, and attempts to act outside an agent's role.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ApiError } from '@google/genai';
import { closeDb, query, queryOne } from '../db/client.js';
import { checkConsistency } from '../db/consistency.js';
import { GeminiService } from '../ai/gemini.js';
import { executeTool } from '../tools/registry.js';

import { runMigrations } from '../db/migrate.js';
import { seedDatabase } from '../db/seed.js';
import { addDays, todayIso } from '../domain/dates.js';
import { AppError } from '../lib/errors.js';
import { listApprovalQueue } from '../repositories/approvals.js';
import { getOrderDetail } from '../repositories/orders.js';
import { getProductBySku } from '../repositories/products.js';
import { SKIP_WITHOUT_DB, ensureTestDatabase } from '../test/db.js';
import {
  type AgentKey,
  type Handler,
  callTool,
  fakeGemini,
  honestAgents,
  json,
  text,
} from '../test/fakeGemini.js';
import {
  approveOrder,
  continueWithCustomerReply,
  processCustomerMessage,
  rejectOrder,
  retryWorkflow,
} from './orderWorkflow.js';

const TODAY = todayIso();
const NEXT_WEEK = addDays(TODAY, 7);
const DEMO = 'I need 3 pink sticker sheets by next week. Can I get a discount?';
const demoExtraction = {
  items: [{ productQuery: 'Pink sticker sheet', quantity: 3 }],
  deadlineText: null,
  deadlineDate: NEXT_WEEK,
  discountRequested: true,
};

function agents(
  extraction: Parameters<typeof honestAgents>[0],
  overrides: Partial<Record<AgentKey, Handler>> = {},
) {
  return fakeGemini({ ...honestAgents(extraction), ...overrides });
}

async function run(message: string, ai: ReturnType<typeof agents>['service'], customerId = 2) {
  return processCustomerMessage({ message, customerId, channel: 'email' }, { ai, today: TODAY });
}

const runs = (orderId: number) =>
  query<{
    agent: string;
    status: string;
    decision: string;
    verification: string;
    next_step: string;
    run_id: string;
    summary: string;
  }>(
    'SELECT agent, status, decision, verification, next_step, run_id, summary FROM agent_runs WHERE order_id = $1 ORDER BY id',
    [orderId],
  );

const dbAvailable = await ensureTestDatabase();

describe('multi-agent order workflow', { skip: !dbAvailable && SKIP_WITHOUT_DB }, () => {
  before(async () => {
    await runMigrations();
  });
  beforeEach(async () => {
    await seedDatabase();
  });
  after(async () => {
    await closeDb();
  });

  it('happy path: every agent runs and the order waits for human approval', async () => {
    const { service, turns } = agents(demoExtraction);
    const r = await run(DEMO, service);

    assert.equal(r.status, 'awaiting_approval');
    assert.equal(r.stopReason, 'human_approval_required');
    assert.deepEqual(
      r.steps.map((s) => `${s.agent}:${s.decision}:${s.verification}`),
      [
        'understanding:continue:matched',
        'pricing:continue:matched',
        'inventory:continue:matched',
        'production:continue:matched',
        'communication:continue:matched',
      ],
    );
    assert.match(r.draftReply!, /\$12\.82/);

    // Each agent only saw its own tools.
    const offered = (agent: AgentKey) => turns.find((t) => t.agent === agent);
    assert.ok(offered('pricing'));

    const order = (await getOrderDetail(r.orderId))!;
    assert.equal(order.totalCents, 1282);
    assert.deepEqual(
      order.items.map((i) => [i.sku, i.quantity, i.unitPriceCents]),
      [['STK-PINK', 3, 450]],
    );
    assert.equal(order.requestedDeadline, NEXT_WEEK);
    assert.ok(order.estimatedCompletion);
    assert.deepEqual(
      order.history.map((h) => h.toStatus),
      ['received', 'processing', 'awaiting_approval'],
    );
    assert.equal(order.messages[0]!.body, DEMO);

    // Logged for the dashboard: one row per agent, same run id, decisions and next steps.
    const rows = await runs(r.orderId);
    assert.deepEqual(
      rows.map((x) => `${x.agent}->${x.next_step}`),
      [
        'understanding->pricing',
        'pricing->inventory',
        'inventory->production',
        'production->communication',
        'communication->awaiting_approval',
      ],
    );
    assert.equal(new Set(rows.map((x) => x.run_id)).size, 1);
    assert.ok(rows.every((x) => x.summary));
  });

  it('a pricing agent that misreports the total is corrected by the tool result', async () => {
    const { service } = agents(demoExtraction, {
      pricing: (t) =>
        t.toolResult
          ? json({
              subtotalCents: 1350,
              discountCents: 500,
              surchargeCents: 0,
              totalCents: 850, // invented
              discountDecision: 'applied',
              offerUpsell: false,
              explanation: 'Gave a generous discount.',
            })
          : callTool('calculateOrderPrice', t.input),
    });
    const r = await run(DEMO, service);
    const step = r.steps.find((s) => s.agent === 'pricing')!;
    assert.equal(step.verification, 'corrected');
    assert.equal((await getOrderDetail(r.orderId))!.totalCents, 1282);
    assert.match(r.draftReply!, /\$12\.82/);
  });

  it('a pricing agent that changes the quantity has its result recomputed by the backend', async () => {
    const { service } = agents(demoExtraction, {
      pricing: (t) =>
        t.toolResult
          ? json({
              subtotalCents: 450,
              discountCents: 0,
              surchargeCents: 0,
              totalCents: 450,
              discountDecision: 'not_eligible',
              offerUpsell: false,
              explanation: '.',
            })
          : callTool('calculateOrderPrice', {
              ...t.input,
              items: [{ productId: t.input.items[0].productId, quantity: 1 }],
            }),
    });
    const r = await run(DEMO, service);
    assert.equal(r.steps.find((s) => s.agent === 'pricing')!.verification, 'recomputed');
    assert.equal((await getOrderDetail(r.orderId))!.totalCents, 1282);
  });

  it('an inventory agent that misreports stock is corrected by the real stock check', async () => {
    const { service } = agents(
      { items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }] },
      {
        inventory: () =>
          json({
            canFulfill: true,
            fullyInStock: true,
            route: 'continue',
            offer: 'none',
            summary: 'All good!',
          }),
      },
    );
    const r = await run('2 washi tape sets please', service);
    const step = r.steps.find((s) => s.agent === 'inventory')!;
    assert.equal(step.verification, 'corrected');
    assert.equal(step.decision, 'stop');
    assert.equal(r.stopReason, 'insufficient_inventory');
  });

  it('skips the Production agent (no Gemini call) when everything ships from stock', async () => {
    const { service, turns } = agents({
      items: [{ productQuery: 'Holographic sticker sheet', quantity: 2 }],
    });
    const r = await run('2 holographic sheets please', service);
    assert.equal(r.status, 'awaiting_approval');
    const step = r.steps.find((s) => s.agent === 'production')!;
    assert.equal(step.verification, 'not_applicable');
    assert.match(step.summary, /^Rule-based/);
    assert.equal(turns.filter((t) => t.agent === 'production').length, 0);
    // Calls per order: understanding 1, pricing 2, inventory 1, communication 1.
    assert.equal(turns.length, 5);
  });

  it('retry resumes after an agent error, reusing the steps that succeeded', async () => {
    let pricingFails = true;
    const { service, turns } = agents(demoExtraction, {
      pricing: (t) => {
        if (pricingFails) return new ApiError({ status: 400, message: 'bad request' });
        return honestAgents(demoExtraction).pricing(t);
      },
    });
    const first = await run(DEMO, service);
    assert.equal(first.stopReason, 'agent_error');
    const understandingCalls = turns.filter((t) => t.agent === 'understanding').length;

    pricingFails = false;
    const retried = await retryWorkflow(first.orderId, { ai: service, today: TODAY });
    assert.equal(retried.status, 'awaiting_approval');
    assert.equal(
      turns.filter((t) => t.agent === 'understanding').length,
      understandingCalls,
      'understanding not re-run',
    );
    assert.match(retried.steps[0]!.summary, /^\(reused from previous run\)/);
    assert.equal((await getOrderDetail(first.orderId))!.totalCents, 1282);
    await assert.rejects(
      retryWorkflow(first.orderId, { ai: service, today: TODAY }),
      (e) => e instanceof AppError && e.code === 'CONFLICT',
    );
  });

  it('an agent cannot use tools it was not given (pricing tries to confirm the order)', async () => {
    const { service } = agents(demoExtraction, {
      pricing: (t) =>
        t.toolResult
          ? t.toolResult.name === 'updateOrderStatus'
            ? callTool('calculateOrderPrice', t.input)
            : json({
                subtotalCents: 1350,
                discountCents: 68,
                surchargeCents: 0,
                totalCents: 1282,
                discountDecision: 'applied',
                offerUpsell: false,
                explanation: '.',
              })
          : callTool('updateOrderStatus', { orderId: 1, status: 'cancelled' }),
    });
    const r = await run(DEMO, service);
    assert.equal(r.status, 'awaiting_approval');
    assert.equal((await getOrderDetail(1))!.status, 'completed', 'order 1 untouched');
    const toolCalls = await queryOne<{ tool_calls: { name: string; ok: boolean }[] }>(
      "SELECT tool_calls FROM agent_runs WHERE order_id = $1 AND agent = 'pricing'",
      [r.orderId],
    );
    assert.deepEqual(
      toolCalls!.tool_calls.map((c) => `${c.name}:${c.ok}`),
      ['updateOrderStatus:false', 'calculateOrderPrice:true'],
    );
  });

  it('stops for missing information and drafts a clarifying reply', async () => {
    const { service } = agents({ items: [{ productQuery: 'stickers', quantity: 2 }] });
    const r = await run('Do you have stickers? I want 2', service);
    assert.equal(r.status, 'needs_info');
    assert.equal(r.stopReason, 'missing_info');
    assert.deepEqual(
      r.steps.map((s) => s.agent),
      ['understanding', 'communication'],
    );
    assert.ok(r.draftReply);
    const order = (await getOrderDetail(r.orderId))!;
    assert.equal(order.stopReason, 'missing_info');
    assert.equal(order.items.length, 0);
  });

  it('stops when the product does not exist', async () => {
    const { service } = agents({ items: [{ productQuery: 'unicorn mug', quantity: 1 }] });
    const r = await run('One unicorn mug please', service);
    assert.equal(r.status, 'needs_info');
    assert.equal(r.stopReason, 'unknown_product');
  });

  it('stops when stock is insufficient and the item cannot be produced', async () => {
    const { service } = agents({ items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }] });
    const r = await run('2 washi tape sets please', service);
    assert.equal(r.status, 'needs_review');
    assert.equal(r.stopReason, 'insufficient_inventory');
    assert.deepEqual(
      r.steps.map((s) => s.agent),
      ['understanding', 'pricing', 'inventory', 'communication'],
    );
  });

  it('stops when the deadline is impossible, reporting the earliest date', async () => {
    const { service, turns } = agents({
      items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 100 }],
      deadlineDate: addDays(TODAY, 1),
    });
    const r = await run('100 packs of custom stickers by tomorrow', service);
    assert.equal(r.status, 'needs_review');
    assert.equal(r.stopReason, 'deadline_impossible');
    const facts = turns.find((t) => t.agent === 'communication')!.input;
    assert.equal(facts.situation, 'deadline_impossible');
    assert.ok(facts.timing.earliestPossible, 'communication agent gets the earliest possible date');
  });

  it('sends the order to review when the reply keeps inventing prices', async () => {
    const { service } = agents(demoExtraction, {
      communication: () =>
        json({ subject: 'Deal', reply: 'Great news, special price just for you: $9.99 total!' }),
    });
    const r = await run(DEMO, service);
    assert.equal(r.status, 'needs_review');
    assert.equal(r.stopReason, 'unverified_reply');
    assert.equal(r.steps.at(-1)!.verification, 'corrected');
  });

  it('records an agent failure and parks the order for review', async () => {
    const { service } = agents(demoExtraction, {
      pricing: () => new ApiError({ status: 400, message: 'bad request' }),
    });
    const r = await run(DEMO, service);
    assert.equal(r.status, 'needs_review');
    assert.equal(r.stopReason, 'agent_error');
    const rows = await runs(r.orderId);
    assert.deepEqual(
      rows.map((x) => `${x.agent}:${x.status}`),
      ['understanding:ok', 'pricing:error'],
    );
  });

  describe('conditional routing', () => {
    const facts = (turns: { agent: string; input: any }[]) =>
      turns.filter((t) => t.agent === 'communication').at(-1)!.input;
    const routes = (r: { steps: { agent: string; route?: string }[] }) =>
      r.steps.map((s) => `${s.agent}:${s.route}`);

    it('CASE 1: in stock and on time → straight to approval', async () => {
      const { service } = agents({
        items: [{ productQuery: 'Holographic sticker sheet', quantity: 2 }],
      });
      const r = await run('2 holographic sheets please', service);
      assert.equal(r.status, 'awaiting_approval');
      assert.deepEqual(routes(r), [
        'understanding:continue',
        'pricing:continue',
        'inventory:continue',
        'production:continue',
        'communication:send_for_approval',
      ]);
    });

    it('CASE 2: out of stock → stops, offers an in-stock substitute from the same category', async () => {
      const { service, turns } = agents({
        items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }],
      });
      const r = await run('2 pastel washi tape sets please', service);
      assert.equal(r.stopReason, 'insufficient_inventory');
      const inv = r.steps.find((s) => s.agent === 'inventory')!;
      assert.equal(inv.route, 'insufficient_stock');
      assert.match(inv.routeReason!, /offer substitute \(WASHI-GOLD\)/);
      assert.equal(facts(turns).offer.type, 'substitute');
      assert.equal(facts(turns).offer.products[0].product, 'Gold foil washi tape set');
      assert.ok(r.approval!.packet.offers.some((o) => o.startsWith('Substitute: Gold foil')));
      assert.equal(
        r.steps.some((s) => s.agent === 'production'),
        false,
        'production skipped',
      );
    });

    it('after a restock, the same out-of-stock request routes straight to approval', async () => {
      const washi = (await getProductBySku('WASHI-PASTEL'))!;
      const restock = await executeTool(
        'restockProduct',
        { productId: washi.id, quantity: 12 },
        { actor: 'human', today: TODAY },
      );
      assert.ok(restock.ok);
      const { service } = agents({
        items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }],
      });
      const r = await run('2 pastel washi tape sets please', service);
      assert.equal(r.status, 'awaiting_approval');
      assert.equal(r.steps.find((s) => s.agent === 'inventory')!.route, 'continue');
    });

    it('CASE 2 → resume: the customer accepts the substitute and the order continues', async () => {
      const { service } = agents(
        { items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }] },
        {
          understanding: (t) =>
            json({
              customer: { name: null, email: null, phone: null },
              // After the customer's answer, they want the substitute.
              items: [
                {
                  productQuery: t.prompt.includes('gold is fine')
                    ? 'Gold foil washi tape set'
                    : 'Pastel washi tape set',
                  quantity: 2,
                },
              ],
              deadlineText: null,
              deadlineDate: null,
              discountRequested: false,
              customization: null,
              otherRequests: null,
              clarificationQuestions: [],
            }),
        },
      );
      const first = await run('2 pastel washi tape sets please', service);
      assert.equal(first.approval!.recommendedAction, 'review');
      assert.match(first.approval!.recommendationReason, /offers a substitute/);

      const resumed = await continueWithCustomerReply(first.orderId, 'Oh ok, the gold is fine!', {
        ai: service,
        today: TODAY,
      });
      assert.equal(resumed.status, 'awaiting_approval');
      const order = (await getOrderDetail(first.orderId))!;
      assert.deepEqual(
        order.items.map((i) => [i.sku, i.quantity]),
        [['WASHI-GOLD', 2]],
      );
    });

    it('CASE 2b: an inventory agent offering a substitute that does not exist is corrected', async () => {
      const { service } = agents(
        {
          items: [
            { productQuery: 'Pastel washi tape set', quantity: 20 },
            { productQuery: 'Gold foil washi tape set', quantity: 20 },
          ],
        },
        {
          inventory: (t) =>
            json({
              canFulfill: false,
              fullyInStock: false,
              route: 'insufficient_stock',
              offer: 'substitute',
              summary: '.',
            }),
        },
      );
      const r = await run('20 pastel and 20 gold washi sets', service);
      const inv = r.steps.find((s) => s.agent === 'inventory')!;
      assert.equal(inv.verification, 'corrected');
      assert.match(inv.routeReason!, /offer (partial|none)/);
    });

    it('CASE 3: deadline impossible → earliest date and a quantity that fits, agent picks one', async () => {
      const { service, turns } = agents(
        {
          items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 40 }],
          deadlineDate: addDays(TODAY, 1),
        },
        {
          production: (t) => {
            if (!t.toolResult) return callTool('calculateEstimatedCompletion', t.input);
            const e = t.toolResult.response.result;
            return json({
              feasible: false,
              estimatedCompletionDate: e.estimatedCompletionDate,
              meetsDeadline: false,
              earliestPossibleDate: e.earliestPossibleDate,
              route: 'propose_alternative',
              alternative: 'reduced_quantity', // the agent's choice
              summary: 'Offer what fits.',
            });
          },
        },
      );
      const r = await run('40 packs of custom stickers by tomorrow', service);
      assert.equal(r.stopReason, 'deadline_impossible');
      const step = r.steps.find((s) => s.agent === 'production')!;
      assert.equal(step.route, 'propose_alternative');
      assert.equal(step.verification, 'matched');
      const f = facts(turns);
      assert.equal(f.proposedAlternative.option, 'a smaller quantity by your deadline');
      assert.ok(f.proposedAlternative.quantity > 0 && f.proposedAlternative.quantity < 40);
      assert.equal(f.otherOptions[0].option, 'the full order on a later date');
      assert.ok(r.approval!.packet.offers.some((o) => o.startsWith('Reduced quantity')));
    });

    it('CASE 3b: an alternative the tools did not offer is replaced by a real one', async () => {
      const { service } = agents(
        {
          items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 40 }],
          deadlineDate: addDays(TODAY, 1),
        },
        {
          production: (t) =>
            t.toolResult
              ? json({
                  feasible: false,
                  estimatedCompletionDate: t.toolResult.response.result.estimatedCompletionDate,
                  meetsDeadline: false,
                  earliestPossibleDate: t.toolResult.response.result.earliestPossibleDate,
                  route: 'propose_alternative',
                  alternative: 'split_delivery', // nothing in stock: not a real option
                  summary: '.',
                })
              : callTool('calculateEstimatedCompletion', t.input),
        },
      );
      const r = await run('40 packs by tomorrow', service);
      const step = r.steps.find((s) => s.agent === 'production')!;
      assert.equal(step.verification, 'corrected');
      assert.doesNotMatch(step.routeReason!, /propose .*now, the rest/);
    });

    it('CASE 4: discount requested but not eligible → Pricing Agent offers the next real tier', async () => {
      const { service, turns } = agents({
        items: [{ productQuery: 'Holographic sticker sheet', quantity: 2 }],
        discountRequested: true,
      });
      const r = await run('2 holo sheets, any discount?', service);
      const pricing = r.steps.find((s) => s.agent === 'pricing')!;
      assert.match(
        pricing.routeReason!,
        /no rule applies at this quantity; offering Volume 3\+: add 1 for 5% off/,
      );
      const tip = facts(turns).quote.howToGetADiscount;
      assert.deepEqual(
        { addUnits: tip.addUnits, newQuantity: tip.newQuantity, newTotal: tip.newTotal },
        { addUnits: 1, newQuantity: 3, newTotal: '$18.52' },
      );
      assert.ok(r.approval!.packet.offers.some((o) => o.startsWith('Upsell: add 1')));
    });

    it('CASE 4b: discount requested and eligible → rules applied, no upsell needed', async () => {
      const { service, turns } = agents(demoExtraction);
      const r = await run(DEMO, service);
      assert.match(r.steps.find((s) => s.agent === 'pricing')!.routeReason!, /Volume 3\+/);
      assert.equal(facts(turns).quote.howToGetADiscount, undefined);
    });

    it('CASE 5: the agent judges critical info missing → pauses with its question', async () => {
      const { service } = agents({
        items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 10 }],
        customization: 'with our logo',
        clarificationQuestions: ['Could you send your logo artwork as a PNG or PDF?'],
      });
      const r = await run('10 packs of custom stickers with our logo please', service);
      assert.equal(r.status, 'needs_info');
      const u = r.steps[0]!;
      assert.equal(u.route, 'ask_clarification');
      assert.match(
        u.routeReason!,
        /Agent judged information missing: Could you send your logo artwork/,
      );
      assert.deepEqual(
        r.steps.map((s) => s.agent),
        ['understanding', 'communication'],
      );
      assert.equal(r.approval!.recommendedAction, 'request_info');
    });

    it('CASE 5 → resume: the customer answers and the workflow continues with the whole conversation', async () => {
      const { service, turns } = agents(
        { items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 10 }] },
        {
          understanding: (t) =>
            json({
              customer: { name: null, email: null, phone: null },
              items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 10 }],
              deadlineText: null,
              deadlineDate: null,
              discountRequested: false,
              customization: 'logo',
              otherRequests: null,
              // Asks for artwork until the conversation contains it.
              clarificationQuestions: t.prompt.includes('artwork attached')
                ? []
                : ['Could you send your logo artwork?'],
            }),
        },
      );
      const first = await run('10 packs of custom stickers with our logo', service);
      assert.equal(first.status, 'needs_info');

      const resumed = await continueWithCustomerReply(
        first.orderId,
        'Sure, artwork attached: logo.png',
        { ai: service, today: TODAY },
      );
      assert.equal(resumed.status, 'awaiting_approval');
      const lastUnderstanding = turns.filter((t) => t.agent === 'understanding').at(-1)!;
      assert.match(
        lastUnderstanding.prompt,
        /Customer: 10 packs of custom stickers[\s\S]*Us: [\s\S]*Customer: Sure, artwork attached/,
      );

      const order = (await getOrderDetail(first.orderId))!;
      assert.deepEqual(
        order.messages.map((m) => m.direction),
        ['inbound', 'outbound', 'inbound'],
      );
      assert.ok(
        order.history.some((h) => h.fromStatus === 'needs_info' && h.toStatus === 'processing'),
      );
      const statuses = await query<{ status: string }>(
        'SELECT status FROM approval_requests WHERE order_id = $1 ORDER BY id',
        [first.orderId],
      );
      assert.deepEqual(
        statuses.map((x) => x.status),
        ['superseded', 'pending'],
      );
      await assert.rejects(
        continueWithCustomerReply(first.orderId, 'again', { ai: service, today: TODAY }),
      );
    });

    it('CASE 6: unknown product → stops and asks the customer', async () => {
      const { service } = agents({ items: [{ productQuery: 'unicorn mug', quantity: 1 }] });
      const r = await run('one unicorn mug', service);
      assert.equal(r.stopReason, 'unknown_product');
      assert.equal(r.steps[0]!.route, 'ask_about_product');
      assert.match(r.steps[0]!.routeReason!, /"unicorn mug"/);
      assert.equal(r.status, 'needs_info');
    });
  });

  describe('failure handling, races, and consistency', () => {
    const consistent = async () => {
      const report = await checkConsistency();
      assert.deepEqual(report.problems, [], 'business invariants hold');
    };

    it('the seeded demo data is consistent', async () => {
      await consistent();
    });

    it('malformed AI output (even after a repair attempt) parks the order and saves nothing', async () => {
      const { service } = agents(demoExtraction, {
        understanding: () => text('this is not JSON at all'),
      });
      const r = await run(DEMO, service);
      assert.equal(r.stopReason, 'agent_error');
      assert.equal(r.approval, null);
      const order = (await getOrderDetail(r.orderId))!;
      assert.equal(order.items.length, 0);
      assert.equal(order.totalCents, null);
      await consistent();
    });

    it('a missing Gemini key parks the order instead of crashing', async () => {
      const r = await processCustomerMessage(
        { message: DEMO, customerId: 2 },
        { ai: new GeminiService({ apiKey: null }), today: TODAY },
      );
      assert.equal(r.status, 'needs_review');
      assert.equal(r.stopReason, 'agent_error');
      assert.match(r.steps[0]!.summary, /not configured/);
    });

    it('a Gemini timeout mid-workflow commits nothing; retry finishes the job', async () => {
      let fail = true;
      const timeout = () =>
        Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      const { service } = agents(demoExtraction, {
        production: (t) => (fail ? timeout() : honestAgents(demoExtraction).production(t)),
      });
      const r = await run(DEMO, service);
      assert.equal(r.stopReason, 'agent_error');
      assert.equal(r.steps.at(-1)!.agent, 'production');
      await consistent();
      fail = false;
      const retried = await retryWorkflow(r.orderId, { ai: service, today: TODAY });
      assert.equal(retried.status, 'awaiting_approval');
    });

    it('two simultaneous approvals: exactly one confirms, stock is reserved once', async () => {
      const { service } = agents(demoExtraction);
      const r = await run(DEMO, service);
      const results = await Promise.allSettled([
        approveOrder(r.orderId, { decidedBy: 'A' }, { ai: service, today: TODAY }),
        approveOrder(r.orderId, { decidedBy: 'B' }, { ai: service, today: TODAY }),
      ]);
      assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
      const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      assert.equal((rejected.reason as AppError).code, 'CONFLICT');
      const order = (await getOrderDetail(r.orderId))!;
      assert.equal(order.history.filter((h) => h.toStatus === 'confirmed').length, 1);
      assert.equal(order.messages.filter((m) => m.direction === 'outbound').length, 1);
      await consistent();
    });

    it('two orders racing for the last stock never oversell', async () => {
      const { service } = agents({ items: [{ productQuery: 'Pink sticker sheet', quantity: 2 }] });
      const a = await processCustomerMessage(
        { message: 'Two pink sheets for me', customerId: 2 },
        { ai: service, today: TODAY },
      );
      const b = await processCustomerMessage(
        { message: 'Two pink sheets for us', customerId: 4 },
        { ai: service, today: TODAY },
      );
      const results = await Promise.allSettled([
        approveOrder(a.orderId, {}, { ai: service, today: TODAY }),
        approveOrder(b.orderId, {}, { ai: service, today: TODAY }),
      ]);
      const pink = (await getProductBySku('STK-PINK'))!.inventory;
      assert.ok(pink.reserved <= pink.onHand, 'never more reserved than on hand');
      await consistent();
      // Whichever lost the race can be approved again: production now covers it.
      for (const [i, res] of results.entries()) {
        if (res.status === 'rejected') {
          const again = await approveOrder([a, b][i]!.orderId, {}, { ai: service, today: TODAY });
          assert.equal(again.order.status, 'confirmed');
          assert.ok(again.order.productionBookings.length > 0);
        }
      }
      await consistent();
    });

    it('concurrent identical messages create one order', async () => {
      const { service } = agents(demoExtraction);
      const results = await Promise.all([
        run(DEMO, service),
        run(DEMO, service),
        run(DEMO, service),
      ]);
      assert.equal(new Set(results.map((r) => r.orderId)).size, 1);
      assert.equal(results.filter((r) => r.duplicate).length, 2);
    });

    it('two customer replies at once resume the order only once', async () => {
      const { service } = agents({ items: [{ productQuery: 'stickers', quantity: 2 }] });
      const r = await run('Do you have stickers? I want 2', service);
      const results = await Promise.allSettled([
        continueWithCustomerReply(r.orderId, 'Pink ones please', { ai: service, today: TODAY }),
        continueWithCustomerReply(r.orderId, 'Pink ones please!', { ai: service, today: TODAY }),
      ]);
      assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
      const inbound = (await getOrderDetail(r.orderId))!.messages.filter(
        (m) => m.direction === 'inbound',
      );
      assert.equal(inbound.length, 2, 'only one reply recorded');
    });

    it('the full lifecycle keeps stock, capacity, and approvals consistent', async () => {
      const { service } = agents(demoExtraction);
      const keep = await run(DEMO, service);
      await approveOrder(keep.orderId, {}, { ai: service, today: TODAY });
      const cancelMe = await processCustomerMessage(
        { message: 'Ten floral bookmarks please', customerId: 1 },
        {
          ai: fakeGemini(
            honestAgents({ items: [{ productQuery: 'Floral bookmark', quantity: 10 }] }),
          ).service,
          today: TODAY,
        },
      );
      await approveOrder(cancelMe.orderId, {}, { ai: service, today: TODAY });
      await consistent();

      const human = { actor: 'human' as const, today: TODAY };
      for (const status of ['in_production', 'ready', 'completed']) {
        const res = await executeTool(
          'updateOrderStatus',
          { orderId: keep.orderId, status },
          human,
        );
        assert.ok(res.ok, status);
      }
      assert.ok(
        (
          await executeTool(
            'updateOrderStatus',
            { orderId: cancelMe.orderId, status: 'cancelled' },
            human,
          )
        ).ok,
      );
      await consistent();
      const bookmark = (await getProductBySku('BKMK-FLORAL'))!.inventory;
      assert.equal(bookmark.reserved, 0, 'cancelled order released its stock');
    });
  });

  describe('human approval', () => {
    const pending = (orderId: number) =>
      queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM approval_requests WHERE order_id = $1 AND status = 'pending'",
        [orderId],
      );

    it('the analysis ends in an approval request, not a confirmed order', async () => {
      const { service } = agents(demoExtraction);
      const r = await run(DEMO, service);
      assert.equal(r.status, 'awaiting_approval');

      const a = r.approval!;
      assert.equal(a.status, 'pending');
      assert.equal(a.packet.customer.name, 'Ben Carter');
      assert.deepEqual(
        a.packet.request.items.map((i) => [i.sku, i.quantity]),
        [['STK-PINK', 3]],
      );
      assert.equal(a.packet.pricing!.totalCents, 1282);
      assert.equal(a.packet.inventory!.lines[0]!.toProduce, 1);
      assert.equal(a.packet.production!.meetsDeadline, true);
      assert.equal(a.packet.response.draftReply, r.draftReply);
      assert.ok(a.packet.warnings.some((w) => w.code === 'low_stock'));
      assert.equal(a.recommendedAction, 'approve');

      // Nothing committed yet: no reservation, no booking, no outbound reply.
      const order = (await getOrderDetail(r.orderId))!;
      assert.equal(order.approval!.id, a.id);
      assert.deepEqual(
        order.items.map((i) => i.reservedQuantity),
        [0],
      );
      assert.equal(order.productionBookings.length, 0);
      assert.equal(order.finalReply, null);
      assert.ok(order.messages.every((m) => m.direction === 'inbound'));
    });

    it('APPROVE confirms, reserves stock, records the decision, and finalises the reply', async () => {
      const { service } = agents(demoExtraction);
      const r = await run(DEMO, service);
      const pinkBefore = (await getProductBySku('STK-PINK'))!.inventory;

      const res = await approveOrder(
        r.orderId,
        { decidedBy: 'Nabiha', note: 'Looks good', reply: 'Edited reply: $12.82, see you soon!' },
        { ai: service, today: TODAY },
      );
      assert.equal(res.order.status, 'confirmed');
      assert.equal(res.order.finalReply, 'Edited reply: $12.82, see you soon!');
      assert.equal(res.order.messages.at(-1)!.direction, 'outbound');
      assert.equal(res.order.history.at(-1)!.actor, 'human');
      assert.match(res.order.history.at(-1)!.note!, /Approved by Nabiha: Looks good/);
      assert.equal(res.steps[0]!.agent, 'order_management');
      assert.equal(res.steps[0]!.verification, 'matched');

      // Audit record of the decision.
      assert.equal(res.approval.status, 'approved');
      assert.equal(res.approval.decidedBy, 'Nabiha');
      assert.equal(res.approval.decisionNote, 'Looks good');
      assert.equal(res.approval.replyEdited, true);
      assert.equal(res.approval.replySent, true);
      assert.ok(res.approval.decidedAt);

      const pinkAfter = (await getProductBySku('STK-PINK'))!.inventory;
      assert.equal(pinkAfter.reserved - pinkBefore.reserved, 2);
      assert.equal(
        res.order.productionBookings.reduce((s, b) => s + b.minutes, 0),
        20,
      );

      await assert.rejects(
        approveOrder(r.orderId, {}, { ai: service, today: TODAY }),
        (e) => e instanceof AppError && e.code === 'CONFLICT',
        'cannot approve twice',
      );
    });

    it('approving with the unedited draft is recorded as not edited', async () => {
      const { service } = agents(demoExtraction);
      const r = await run(DEMO, service);
      const res = await approveOrder(r.orderId, {}, { ai: service, today: TODAY });
      assert.equal(res.approval.replyEdited, false);
      assert.equal(res.order.finalReply, r.draftReply);
      assert.equal(res.approval.decidedBy, 'shop owner');
    });

    it('REJECT confirms nothing, records the decision, and can send the reply', async () => {
      const { service } = agents(demoExtraction);
      const r = await run(DEMO, service);
      const pinkBefore = (await getProductBySku('STK-PINK'))!.inventory;

      const res = await rejectOrder(r.orderId, {
        decidedBy: 'Nabiha',
        note: 'Too busy this week',
        sendReply: true,
        reply: 'Sorry, we are fully booked this week.',
      });
      assert.equal(res.order.status, 'rejected');
      assert.equal(res.approval!.status, 'rejected');
      assert.equal(res.approval!.decidedBy, 'Nabiha');
      assert.equal(res.approval!.replySent, true);
      assert.equal(res.order.finalReply, 'Sorry, we are fully booked this week.');
      assert.ok(!res.order.history.some((h) => h.toStatus === 'confirmed'));
      assert.deepEqual(
        (await getProductBySku('STK-PINK'))!.inventory,
        pinkBefore,
        'stock untouched',
      );
      assert.equal((await pending(r.orderId))!.n, 0);

      await assert.rejects(rejectOrder(r.orderId, {}), (e) => e instanceof AppError);
    });

    it('a stopped order can be rejected with its explanation reply', async () => {
      const { service } = agents({
        items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }],
      });
      const r = await run('2 washi tape sets please', service);
      // A substitute is on offer, so the agents suggest sending it; the owner rejects instead.
      assert.equal(r.approval!.recommendedAction, 'review');

      const res = await rejectOrder(r.orderId, { sendReply: true });
      assert.equal(res.order.status, 'rejected');
      assert.equal(res.order.finalReply, r.draftReply);
      assert.equal(res.approval!.replyEdited, false);
    });

    it('cannot approve an order waiting for customer information', async () => {
      const { service } = agents({ items: [{ productQuery: 'unicorn mug', quantity: 1 }] });
      const r = await run('unicorn mug', service);
      assert.equal(r.approval!.recommendedAction, 'request_info');
      await assert.rejects(
        approveOrder(r.orderId, {}, { ai: service, today: TODAY }),
        (e) => e instanceof AppError && /waiting for information/.test(e.message),
      );
      assert.equal((await pending(r.orderId))!.n, 1, 'request stays open');
    });

    it('a reviewed order (deadline impossible) can be approved once the person accepts the later date', async () => {
      const { service } = agents({
        items: [{ productQuery: 'Custom die-cut stickers (pack of 10)', quantity: 10 }],
        deadlineDate: addDays(TODAY, 0),
      });
      const r = await run('10 packs of custom stickers today', service);
      assert.equal(r.status, 'needs_review');
      assert.equal(r.approval!.recommendedAction, 'review');

      const res = await approveOrder(
        r.orderId,
        { note: 'Customer accepted the later date' },
        { ai: service, today: TODAY },
      );
      assert.equal(res.order.status, 'confirmed');
      assert.deepEqual(
        res.order.history.slice(-2).map((h) => `${h.toStatus}:${h.actor}`),
        ['awaiting_approval:human', 'confirmed:human'],
      );
    });

    it('business validation still applies on approval: unfulfillable orders are refused', async () => {
      const { service } = agents({
        items: [{ productQuery: 'Pastel washi tape set', quantity: 2 }],
      });
      const r = await run('2 washi tape sets please', service);
      await assert.rejects(
        approveOrder(r.orderId, {}, { ai: service, today: TODAY }),
        (e) => e instanceof AppError && e.code === 'CONFLICT',
      );
      const order = (await getOrderDetail(r.orderId))!;
      assert.notEqual(order.status, 'confirmed');
      assert.equal(order.approval!.status, 'pending', 'no decision recorded');
    });

    it('a failed analysis has no approval request and cannot be approved', async () => {
      const { service } = agents(demoExtraction, {
        pricing: () => new ApiError({ status: 400, message: 'bad request' }),
      });
      const r = await run(DEMO, service);
      assert.equal(r.approval, null);
      await assert.rejects(
        approveOrder(r.orderId, {}, { ai: service, today: TODAY }),
        (e) => e instanceof AppError && /no pending approval/.test(e.message),
      );
    });

    it('re-analysing an order supersedes its old approval request', async () => {
      const { service } = agents(demoExtraction, {
        pricing: () => new ApiError({ status: 400, message: 'bad request' }),
      });
      const r = await run(DEMO, service);
      const fixed = agents(demoExtraction).service;
      const retried = await retryWorkflow(r.orderId, { ai: fixed, today: TODAY });
      assert.equal(retried.approval!.status, 'pending');
      assert.equal((await pending(r.orderId))!.n, 1);
    });

    it('the Order Management Agent cannot touch other orders; the backend confirms the right one', async () => {
      const { service } = agents(demoExtraction, {
        order_management: (t) =>
          t.toolResult
            ? json({ confirmed: true, promisedDate: null, summary: 'Done.' })
            : callTool('updateOrderStatus', { orderId: 4, status: 'confirmed' }), // a different order
      });
      const r = await run(DEMO, service);
      const res = await approveOrder(r.orderId, {}, { ai: service, today: TODAY });
      assert.equal(res.order.status, 'confirmed');
      assert.equal(res.steps[0]!.verification, 'recomputed');
      assert.equal((await getOrderDetail(4))!.status, 'awaiting_approval', 'order 4 untouched');
    });

    it('seeded orders waiting on a person have approval requests in the queue', async () => {
      const queue = await listApprovalQueue();
      assert.deepEqual(queue.map((q) => `${q.customerName}:${q.recommendedAction}`).sort(), [
        'Leo Martin:approve',
        'Priya Sharma:request_info',
      ]);
      const { order } = await rejectOrder(4, { note: 'Out of season' });
      assert.equal(order.status, 'rejected');
      assert.equal(order.approval!.status, 'rejected');
    });
  });
});
