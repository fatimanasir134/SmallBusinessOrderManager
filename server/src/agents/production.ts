/**
 * 4. Production Agent
 * Responsibility: check production capacity and whether the deadline can be met.
 * Tools: calculateEstimatedCompletion (required), checkProductionCapacity (optional detail).
 * Stops the workflow when the deadline is impossible.
 */
import { z } from 'zod';
import type { DeadlineAlternative } from '../domain/alternatives.js';
import type { CompletionEstimate } from '../domain/production.js';
import type { OrderLineInput } from '../tools/schemas.js';
import { executeTool, toolsForGemini } from '../tools/registry.js';
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

export const TOOLS = ['calculateEstimatedCompletion', 'checkProductionCapacity'] as const;

export const outputSchema = z.object({
  feasible: z
    .boolean()
    .describe('True if the order can be completed by the deadline (or at all, if none)'),
  estimatedCompletionDate: z.string().nullable().describe('YYYY-MM-DD from the tool'),
  meetsDeadline: z.boolean().nullable().describe('From the tool; null when there is no deadline'),
  earliestPossibleDate: z.string().nullable().describe('From the tool'),
  route: z
    .enum(['continue', 'propose_alternative'])
    .describe('continue if feasible; propose_alternative if the deadline cannot be met'),
  alternative: z
    .enum(['later_date', 'reduced_quantity', 'split_delivery'])
    .nullable()
    .describe('Which of the tool’s alternatives to offer (null when feasible)'),
  summary: z.string().describe('One sentence for the shop owner'),
});

export const SYSTEM_INSTRUCTION = `You are the Production Agent for ${BUSINESS_NAME}.
Your only job: decide whether an order can be produced in time, using the backend tools.

Rules:
- Call calculateEstimatedCompletion exactly once with exactly the items and requestedDeadline you
  are given. Use checkProductionCapacity only if you need the day-by-day free time.
- Report the tool's dates exactly. Never invent dates or capacity.
- feasible = the tool found a completion date and it meets the deadline (or there is no deadline).
- Decide the route: continue when feasible. Otherwise propose_alternative, and choose the
  alternative from the tool's "alternatives" list that best fits the customer: reduced_quantity
  when the date matters most, later_date when they need the full quantity, split_delivery when
  part of it is in stock now.
- Then answer with the JSON summary.`;

export type ProductionOutput = {
  estimate: CompletionEstimate & {
    earliestPossibleDate: string | null;
    alternatives?: DeadlineAlternative[];
  };
  feasible: boolean;
  summary: string;
  /** The alternative offered when the deadline can't be met. */
  alternative: DeadlineAlternative | null;
};

export async function run(
  ctx: AgentContext,
  input: { items: OrderLineInput[]; requestedDeadline: string | null; productionMinutes: number },
): Promise<AgentOutcome<ProductionOutput>> {
  const args = {
    items: input.items,
    ...(input.requestedDeadline && { requestedDeadline: input.requestedDeadline }),
  };
  const res = await ctx.ai.runTools({
    label: 'production',
    systemInstruction: SYSTEM_INSTRUCTION,
    contents:
      `Check production for this order (inventory says ${input.productionMinutes} minutes of ` +
      `production are needed):\n${JSON.stringify(args, null, 2)}`,
    ...toolsForGemini(TOOLS, agentToolContext(ctx)),
    outputSchema,
    temperature: 0,
    thinking: 'low',
  });

  const { result: estimate, recomputed } = await verifiedToolResult<ProductionOutput['estimate']>(
    ctx,
    res.toolCalls,
    'calculateEstimatedCompletion',
    args,
    (a) =>
      sameLines(a.items, input.items) && (a.requestedDeadline ?? null) === input.requestedDeadline,
  );

  const feasible = estimate.estimatedCompletionDate !== null && estimate.meetsDeadline !== false;
  const discrepancies = compareClaims(
    {
      feasible: res.data.feasible,
      estimatedCompletionDate: res.data.estimatedCompletionDate,
      meetsDeadline: res.data.meetsDeadline,
    },
    {
      feasible,
      estimatedCompletionDate: estimate.estimatedCompletionDate,
      meetsDeadline: estimate.meetsDeadline,
    },
  );

  const route = feasible ? 'continue' : 'propose_alternative';
  if (res.data.route !== route) {
    discrepancies.push(`route: agent said ${res.data.route}, schedule says ${route}`);
  }
  const options = estimate.alternatives ?? [];
  let alternative: DeadlineAlternative | null = null;
  if (!feasible) {
    alternative = options.find((a) => a.type === res.data.alternative) ?? null;
    if (!alternative) {
      alternative = options[0] ?? null;
      discrepancies.push(
        `alternative: agent chose ${res.data.alternative ?? 'none'}, not among the tool's options; using ${alternative?.type ?? 'none'}`,
      );
    }
  }
  return {
    route,
    routeReason: routeReasonFor(estimate, alternative),
    output: { estimate, feasible, summary: res.data.summary, alternative },
    summary:
      estimate.summary +
      (!feasible && estimate.earliestPossibleDate
        ? ` Earliest possible: ${estimate.earliestPossibleDate}.`
        : ''),
    decision: feasible ? 'continue' : 'stop',
    stopReason: feasible ? undefined : 'deadline_impossible',
    verification: verificationOf(recomputed, discrepancies),
    toolCalls: res.toolCalls,
    discrepancies,
    model: res.model,
  };
}

/**
 * Rule-based path, no AI: when everything ships from stock there is nothing to schedule, so the
 * backend answers directly (saves two Gemini calls). Logged like any other step.
 */
export async function runRuleBased(
  ctx: AgentContext,
  input: { items: OrderLineInput[]; requestedDeadline: string | null },
): Promise<AgentOutcome<ProductionOutput>> {
  const args = {
    items: input.items,
    ...(input.requestedDeadline && { requestedDeadline: input.requestedDeadline }),
  };
  const start = Date.now();
  const r = await executeTool('calculateEstimatedCompletion', args, agentToolContext(ctx));
  if (!r.ok) throw new Error(`calculateEstimatedCompletion failed: ${r.error.message}`);
  const estimate = r.result as ProductionOutput['estimate'];
  const feasible = estimate.estimatedCompletionDate !== null && estimate.meetsDeadline !== false;
  const alternative = feasible ? null : (estimate.alternatives?.[0] ?? null);
  return {
    route: feasible ? 'continue' : 'propose_alternative',
    routeReason: routeReasonFor(estimate, alternative),
    output: { estimate, feasible, summary: estimate.summary, alternative },
    summary: `Rule-based (no production needed): ${estimate.summary}`,
    decision: feasible ? 'continue' : 'stop',
    stopReason: feasible ? undefined : 'deadline_impossible',
    verification: 'not_applicable',
    toolCalls: [
      {
        name: 'calculateEstimatedCompletion',
        source: 'backend',
        args,
        ok: true,
        response: { result: estimate },
        durationMs: Date.now() - start,
      },
    ],
    discrepancies: [],
  };
}

function describeAlternative(a: DeadlineAlternative): string {
  switch (a.type) {
    case 'later_date':
      return `full order by ${a.readyBy}`;
    case 'reduced_quantity':
      return `${a.quantity} of ${a.requested} × ${a.sku} by ${a.readyBy}`;
    case 'split_delivery':
      return `${a.now.map((n) => `${n.quantity} × ${n.sku}`).join(', ')} now, the rest by ${a.restReadyBy}`;
  }
}

function routeReasonFor(
  e: ProductionOutput['estimate'],
  alternative: DeadlineAlternative | null,
): string {
  if (e.meetsDeadline !== false) {
    return e.needsProduction
      ? `Schedule: ready ${e.estimatedCompletionDate}${e.requestedDeadline ? `, deadline ${e.requestedDeadline} met` : ''}.`
      : 'Everything ships from stock: ready today.';
  }
  const options = (e.alternatives ?? []).map((a) => a.type).join(', ');
  return (
    `Schedule: earliest ${e.earliestPossibleDate ?? 'beyond capacity'}, misses ${e.requestedDeadline} → ` +
    `propose ${alternative ? describeAlternative(alternative) : 'nothing'} (options: ${options || 'none'}).`
  );
}
