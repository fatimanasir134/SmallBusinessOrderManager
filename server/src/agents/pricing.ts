/**
 * 2. Pricing Agent
 * Responsibility: determine the order price with the pricing tool and explain the discount decision.
 * Tools: calculateOrderPrice. It must not invent prices: the quote used downstream is always
 * the tool's result, checked against the agent's report.
 */
import { z } from 'zod';
import type { DiscountOpportunity } from '../domain/alternatives.js';
import type { PriceQuote } from '../domain/pricing.js';
import type { OrderLineInput } from '../tools/schemas.js';
import { toolsForGemini } from '../tools/registry.js';
import {
  type AgentContext,
  type AgentOutcome,
  BUSINESS_NAME,
  agentToolContext,
  compareClaims,
  sameLines,
  verificationOf,
  verifiedToolResult,
} from './runtime.js';

export const TOOLS = ['calculateOrderPrice'] as const;

export interface PricingInput {
  items: OrderLineInput[];
  customerId: number | null;
  requestedDeadline: string | null;
  discountRequested: boolean;
}

export const outputSchema = z.object({
  subtotalCents: z.number().int().describe('From the tool'),
  discountCents: z.number().int().describe('From the tool'),
  surchargeCents: z.number().int().describe('From the tool'),
  totalCents: z.number().int().describe('From the tool'),
  discountDecision: z
    .enum(['applied', 'not_eligible', 'not_requested'])
    .describe('applied = a rule gave a discount; not_eligible = asked but no rule applies'),
  offerUpsell: z
    .boolean()
    .describe(
      'True to suggest the nearest volume tier from discountOpportunities (only if one exists)',
    ),
  explanation: z.string().describe('One or two sentences for the shop owner'),
});

export const SYSTEM_INSTRUCTION = `You are the Pricing Agent for ${BUSINESS_NAME}.
Your only job: price an order using the calculateOrderPrice tool and explain the discount decision.

Rules:
- Call calculateOrderPrice exactly once, with exactly the items, customerId, requestedDeadline, and
  discountRequested you are given. Never change products or quantities.
- Never invent, estimate, round, or adjust prices. Report the tool's numbers exactly (integer cents).
- Discounts come only from the pricing rules the tool applies. Never promise extra discounts.
- Decide the discount outcome from the tool result. If the customer asked for a discount and no
  rule applies, look at discountOpportunities: if there is one, set offerUpsell to true so we can
  tell them exactly how to qualify. Otherwise set offerUpsell to false.
- Then answer with the JSON summary.`;

export type PricedOpportunity = DiscountOpportunity & { sku: string; name: string };

export type PricingOutput = {
  quote: PriceQuote & { customerTier: string | null; discountOpportunities?: PricedOpportunity[] };
  discountDecision: z.infer<typeof outputSchema>['discountDecision'];
  /** The volume tier offered to the customer, when the agent chose to offer one. */
  upsell: PricedOpportunity | null;
  explanation: string;
};

export async function run(
  ctx: AgentContext,
  input: PricingInput,
): Promise<AgentOutcome<PricingOutput>> {
  const args = {
    items: input.items,
    ...(input.customerId && { customerId: input.customerId }),
    ...(input.requestedDeadline && { requestedDeadline: input.requestedDeadline }),
    discountRequested: input.discountRequested,
  };

  const res = await ctx.ai.runTools({
    label: 'pricing',
    systemInstruction: SYSTEM_INSTRUCTION,
    contents: `Price this order:\n${JSON.stringify(args, null, 2)}`,
    ...toolsForGemini(TOOLS, agentToolContext(ctx)),
    outputSchema,
    temperature: 0,
    thinking: 'low',
  });

  const { result: quote, recomputed } = await verifiedToolResult<PricingOutput['quote']>(
    ctx,
    res.toolCalls,
    'calculateOrderPrice',
    args,
    (a) =>
      sameLines(a.items, input.items) &&
      (a.customerId ?? null) === input.customerId &&
      (a.requestedDeadline ?? null) === input.requestedDeadline,
  );

  const claims = res.data;
  const discrepancies = compareClaims(claims, {
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    surchargeCents: quote.surchargeCents,
    totalCents: quote.totalCents,
  });
  // The discount decision must also agree with the numbers.
  const decision =
    quote.discountCents > 0
      ? 'applied'
      : input.discountRequested
        ? 'not_eligible'
        : 'not_requested';
  if (claims.discountDecision !== decision) {
    discrepancies.push(
      `discountDecision: agent said ${claims.discountDecision}, tools say ${decision}`,
    );
  }

  // The agent decides whether to offer an upsell; only a real opportunity from the tool counts.
  const opportunities = quote.discountOpportunities ?? [];
  if (claims.offerUpsell && opportunities.length === 0) {
    discrepancies.push(
      'offerUpsell: agent wanted to suggest a volume tier, but the tools found none',
    );
  }
  const upsell = claims.offerUpsell ? (opportunities[0] ?? null) : null;

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const rules = quote.appliedRules
    .filter((r) => r.ruleType !== 'rush_surcharge')
    .map((r) => r.name);
  const routeReason = !input.discountRequested
    ? 'No discount requested; standard pricing rules applied.'
    : decision === 'applied'
      ? `Discount requested → pricing rules give ${rules.join(' + ')} (${money(quote.discountCents)} off).`
      : upsell
        ? `Discount requested → no rule applies at this quantity; offering ${upsell.ruleName}: add ${upsell.addUnits} for ${upsell.newLineDiscountPercent}% off.`
        : 'Discount requested → no pricing rule applies, and no nearby tier to suggest.';
  return {
    route: 'continue',
    routeReason,
    output: { quote, discountDecision: decision, upsell, explanation: claims.explanation },
    summary:
      `Total ${money(quote.totalCents)} (subtotal ${money(quote.subtotalCents)}` +
      (quote.discountCents ? `, discount -${money(quote.discountCents)}` : '') +
      (quote.surchargeCents ? `, rush +${money(quote.surchargeCents)}` : '') +
      `); discount ${decision.replace('_', ' ')}`,
    decision: 'continue',
    verification: verificationOf(recomputed, discrepancies),
    toolCalls: res.toolCalls,
    discrepancies,
    model: res.model,
  };
}
