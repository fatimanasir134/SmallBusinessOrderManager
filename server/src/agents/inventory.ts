/**
 * 3. Inventory Agent
 * Responsibility: report whether the order can be fulfilled from real stock (or with production for
 * items the studio can make), and flag stock concerns for the owner.
 * Tools: checkInventory, run by the backend before the agent reasons (one Gemini call instead of
 * a tool round-trip, to save free-tier quota). The agent interprets the result; its claims are
 * checked against it. Stops the workflow when items can't be supplied at all.
 */
import { z } from 'zod';
import type { ToolCallRecord } from '../ai/gemini.js';
import type { Substitute } from '../domain/alternatives.js';
import type { InventoryAssessment } from '../domain/inventory.js';
import type { OrderLineInput } from '../tools/schemas.js';
import { executeTool } from '../tools/registry.js';
import {
  type AgentContext,
  type AgentOutcome,
  BUSINESS_NAME,
  agentToolContext,
  compareClaims,
  verificationOf,
} from './runtime.js';

export const TOOLS = ['checkInventory'] as const;

export const outputSchema = z.object({
  canFulfill: z
    .boolean()
    .describe('True if every unit can come from stock or production (tool: fulfillable)'),
  fullyInStock: z.boolean().describe('True if nothing needs producing (tool: allInStock)'),
  route: z
    .enum(['continue', 'insufficient_stock'])
    .describe('continue if the order can be fulfilled; insufficient_stock if not'),
  offer: z
    .enum(['substitute', 'partial', 'none'])
    .describe(
      'When insufficient: offer a product from substitutes, the part we can supply, or nothing',
    ),
  summary: z
    .string()
    .describe('One or two sentences for the shop owner, including any reorder warnings'),
});

export const SYSTEM_INSTRUCTION = `You are the Inventory Agent for ${BUSINESS_NAME}.
Your only job: read the result of the checkInventory tool for an order and report whether the order
can be fulfilled, plus anything the owner should know (e.g. stock falling below its reorder point).

Rules:
- Report only what the tool result says: fulfillable -> canFulfill, allInStock -> fullyInStock.
- Short units can be produced unless the line is marked producible: false.
- Decide the route: continue when the order can be fulfilled, otherwise insufficient_stock.
- When insufficient, decide what to offer the customer instead: "substitute" (only if the result
  lists substitutes), "partial" (the units we can supply), or "none". Pick what best serves them.
- Never guess stock levels. Answer with the JSON summary.`;

export type InventoryOutput = {
  assessment: InventoryAssessment;
  summary: string;
  /** What we offer when the order can't be fulfilled as asked. */
  offer: 'substitute' | 'partial' | 'none';
  substitutes: Substitute[];
};

export async function run(
  ctx: AgentContext,
  input: { items: OrderLineInput[] },
): Promise<AgentOutcome<InventoryOutput>> {
  // The backend runs the stock check, so the facts never depend on the model.
  const start = Date.now();
  const check = await executeTool('checkInventory', { items: input.items }, agentToolContext(ctx));
  if (!check.ok) throw new Error(`checkInventory failed: ${check.error.message}`);
  const assessment = check.result as InventoryAssessment & { substitutes: Substitute[] };
  const toolCall: ToolCallRecord = {
    name: 'checkInventory',
    source: 'backend',
    args: { items: input.items },
    ok: true,
    response: { result: assessment },
    durationMs: Date.now() - start,
  };

  const res = await ctx.ai.generateStructured({
    label: 'inventory',
    systemInstruction: SYSTEM_INSTRUCTION,
    contents: `checkInventory result for this order:\n${JSON.stringify(assessment, null, 2)}`,
    schema: outputSchema,
    temperature: 0,
    thinking: 'low',
  });

  const discrepancies = compareClaims(
    { canFulfill: res.data.canFulfill, fullyInStock: res.data.fullyInStock },
    { canFulfill: assessment.fulfillable, fullyInStock: assessment.allInStock },
  );
  // Route: must match the stock facts. Offer: the agent's choice, if the facts allow it.
  const route = assessment.fulfillable ? 'continue' : 'insufficient_stock';
  if (res.data.route !== route) {
    discrepancies.push(`route: agent said ${res.data.route}, stock says ${route}`);
  }
  const canPartial = assessment.lines.some((l) => l.requested - l.unfulfillable > 0);
  const valid = {
    substitute: assessment.substitutes.length > 0,
    partial: canPartial,
    none: true,
  };
  let offer: InventoryOutput['offer'] = 'none';
  if (route === 'insufficient_stock') {
    if (valid[res.data.offer]) offer = res.data.offer;
    else {
      offer = valid.substitute ? 'substitute' : valid.partial ? 'partial' : 'none';
      discrepancies.push(
        `offer: agent chose ${res.data.offer}, which the stock doesn't allow; using ${offer}`,
      );
    }
  }

  const lines = assessment.lines
    .map((l) =>
      l.unfulfillable
        ? `${l.sku}: ${l.fromStock}/${l.requested} in stock, ${l.unfulfillable} unavailable`
        : `${l.sku}: ${l.fromStock} from stock${l.toProduce ? `, ${l.toProduce} to produce` : ''}`,
    )
    .join('; ');

  const routeReason =
    route === 'continue'
      ? assessment.allInStock
        ? 'checkInventory: everything is in stock.'
        : `checkInventory: ${assessment.totalToProduce} unit(s) short, but they can be produced.`
      : `checkInventory: ${assessment.lines
          .filter((l) => l.unfulfillable)
          .map((l) => `${l.unfulfillable} × ${l.sku} unavailable and not producible`)
          .join(', ')} → stop; offer ${offer}` +
        (offer === 'substitute'
          ? ` (${assessment.substitutes.map((s) => s.sku).join(', ')})`
          : '') +
        '.';
  return {
    route,
    routeReason,
    output: { assessment, summary: res.data.summary, offer, substitutes: assessment.substitutes },
    summary: (assessment.fulfillable ? 'Can fulfil. ' : 'Cannot fulfil. ') + lines,
    decision: assessment.fulfillable ? 'continue' : 'stop',
    stopReason: assessment.fulfillable ? undefined : 'insufficient_inventory',
    verification: verificationOf(false, discrepancies),
    toolCalls: [toolCall],
    discrepancies,
    model: res.model,
  };
}
