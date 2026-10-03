/**
 * Shared agent plumbing. Every agent:
 *  - has one responsibility, its own system instruction, and a zod output schema;
 *  - may call only the tools listed for it (Gemini is only shown those declarations);
 *  - returns an AgentOutcome: the *verified* output, what it decided, and how it was verified.
 *
 * Verification rule: numbers and facts come from backend tool results, never from the model's
 * text. If the agent misreports a result we use the tool's ("corrected"); if it skipped its tool
 * or called it with different items, the backend runs the tool itself ("recomputed").
 */
import type { Verification } from '@sbom/shared';
import type { ToolCallRecord } from '../ai/gemini.js';
import { mergeLines, type OrderLineInput } from '../tools/schemas.js';
import { executeTool, type ToolName } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { AgentContext } from './types.js';

export { type AgentContext, type AgentOutcome, BUSINESS_NAME } from './types.js';

/** Tool context for agents: always actor 'agent', so status rules apply to them. */
export const agentToolContext = (ctx: AgentContext): ToolContext => ({
  actor: 'agent',
  today: ctx.today,
  orderId: ctx.orderId,
});

/** The last successful call to `name` whose arguments pass `matches`. */
export function successfulCall(
  calls: ToolCallRecord[],
  name: ToolName,
  matches: (args: Record<string, unknown>) => boolean = () => true,
): { args: Record<string, unknown>; result: unknown } | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    const args = (c.args ?? {}) as Record<string, unknown>;
    if (c.name === name && c.ok && matches(args)) {
      return { args, result: (c.response as { result: unknown }).result };
    }
  }
  return undefined;
}

/** Same products and quantities, regardless of order or duplicate lines. */
export function sameLines(actual: unknown, expected: OrderLineInput[]): boolean {
  if (!Array.isArray(actual)) return false;
  const norm = (lines: OrderLineInput[]) =>
    mergeLines(lines)
      .sort((a, b) => a.productId - b.productId)
      .map((l) => `${l.productId}x${l.quantity}`)
      .join(',');
  try {
    return norm(actual as OrderLineInput[]) === norm(expected);
  } catch {
    return false;
  }
}

/**
 * Get the authoritative tool result: the agent's own matching call if it made one, otherwise
 * run the tool from the backend with the correct arguments.
 */
export async function verifiedToolResult<R>(
  ctx: AgentContext,
  calls: ToolCallRecord[],
  name: ToolName,
  expectedArgs: Record<string, unknown>,
  matches: (args: Record<string, unknown>) => boolean,
): Promise<{ result: R; recomputed: boolean }> {
  const own = successfulCall(calls, name, matches);
  if (own) return { result: own.result as R, recomputed: false };
  const r = await executeTool(name, expectedArgs, agentToolContext(ctx));
  if (!r.ok) {
    throw Object.assign(new Error(`${name} failed: ${r.error.message}`), { toolError: r.error });
  }
  return { result: r.result as R, recomputed: true };
}

/** Compare named fields between the agent's claims and the verified values. */
export function compareClaims(
  claims: Record<string, unknown>,
  verified: Record<string, unknown>,
): string[] {
  return Object.keys(claims)
    .filter((k) => k in verified && JSON.stringify(claims[k]) !== JSON.stringify(verified[k]))
    .map(
      (k) =>
        `${k}: agent said ${JSON.stringify(claims[k])}, tools say ${JSON.stringify(verified[k])}`,
    );
}

export function verificationOf(recomputed: boolean, discrepancies: string[]): Verification {
  if (recomputed) return 'recomputed';
  return discrepancies.length ? 'corrected' : 'matched';
}
