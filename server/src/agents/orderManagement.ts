/**
 * 6. Order Management Agent
 * Responsibility: after a person approves an order, carry out the confirmation with the order
 * tool and report the result (promised date, reserved stock, booked production).
 * Tools: updateOrderStatus, wrapped in a guard so this agent can only confirm the one order the
 * person approved. The business rules inside the tool (stock, capacity, transitions) still apply.
 */
import { z } from 'zod';
import type { ToolExecutor } from '../ai/gemini.js';
import { getOrderDetail } from '../repositories/orders.js';
import { executeTool, geminiFunctionDeclarations } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import {
  type AgentContext,
  type AgentOutcome,
  BUSINESS_NAME,
  compareClaims,
  successfulCall,
  verificationOf,
} from './runtime.js';

export const TOOLS = ['updateOrderStatus'] as const;

export const outputSchema = z.object({
  confirmed: z.boolean().describe('True if updateOrderStatus succeeded'),
  promisedDate: z.string().nullable().describe('effects.promisedDate from the tool, or null'),
  summary: z.string().describe('One sentence for the shop owner'),
});

export const SYSTEM_INSTRUCTION = `You are the Order Management Agent for ${BUSINESS_NAME}.
A person has approved an order. Your only job: record that approval in the order system.

Rules:
- Call updateOrderStatus once with the given orderId, status "confirmed", and the approval note.
- Confirming reserves stock and books production; report the promised date from the tool result.
- If the tool returns an error, do not try other statuses or orders: report the error.
- Then answer with the JSON summary.`;

export interface ConfirmEffects {
  reserved: { productId: number; quantity: number }[];
  productionBooked: { day: string; minutes: number }[];
  promisedDate?: string;
}

export type OrderManagementOutput = {
  confirmed: boolean;
  effects: ConfirmEffects | null;
  error?: string;
};

/** The only call this agent may make: confirm the approved order. Anything else is refused. */
function guardedExecutor(orderId: number, toolCtx: ToolContext): ToolExecutor {
  return async (name, args) => {
    const a = (args ?? {}) as { orderId?: unknown; status?: unknown };
    if (name !== 'updateOrderStatus' || a.orderId !== orderId || a.status !== 'confirmed') {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: `Only updateOrderStatus with orderId ${orderId} and status "confirmed" is allowed.`,
        },
      };
    }
    const r = await executeTool(name, args, toolCtx);
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
  };
}

export async function run(
  ctx: AgentContext,
  input: { orderId: number; approvedBy: string; note: string },
): Promise<AgentOutcome<OrderManagementOutput>> {
  // The person approved, so the confirmation is made with their authority, for this order only.
  const toolCtx: ToolContext = { actor: 'human', today: ctx.today, orderId: input.orderId };
  const res = await ctx.ai.runTools({
    label: 'order_management',
    systemInstruction: SYSTEM_INSTRUCTION,
    contents: `Approved order:\n${JSON.stringify(input, null, 2)}`,
    declarations: geminiFunctionDeclarations(TOOLS),
    execute: guardedExecutor(input.orderId, toolCtx),
    outputSchema,
    temperature: 0,
    thinking: 'low',
  });

  // Verify against the database, not the agent's word.
  let call = successfulCall(res.toolCalls, 'updateOrderStatus', (a) => a.orderId === input.orderId);
  let recomputed = false;
  let error: string | undefined;
  if (!call) {
    const order = await getOrderDetail(input.orderId);
    if (order?.status !== 'confirmed') {
      // The agent didn't confirm (or its call failed): do it from the backend so the rules decide.
      recomputed = true;
      const r = await executeTool(
        'updateOrderStatus',
        { orderId: input.orderId, status: 'confirmed', note: input.note },
        toolCtx,
      );
      if (r.ok) call = { args: {}, result: r.result };
      else error = r.error.message;
    }
  }
  const effects = (call?.result as { effects?: ConfirmEffects } | undefined)?.effects ?? null;
  const confirmed = Boolean(effects);
  const discrepancies = compareClaims(
    { confirmed: res.data.confirmed, promisedDate: res.data.promisedDate },
    { confirmed, promisedDate: effects?.promisedDate ?? null },
  );

  return {
    output: { confirmed, effects, ...(error && { error }) },
    summary: confirmed
      ? `Confirmed. Promised for ${effects!.promisedDate}; reserved ${effects!.reserved.length} line(s), booked ${effects!.productionBooked.reduce((s, b) => s + b.minutes, 0)} production min.`
      : `Could not confirm: ${error ?? res.data.summary}`,
    decision: confirmed ? 'continue' : 'stop',
    verification: verificationOf(recomputed, discrepancies),
    toolCalls: res.toolCalls,
    discrepancies,
    model: res.model,
    route: confirmed ? 'confirmed' : 'not_confirmed',
    routeReason: confirmed
      ? 'updateOrderStatus succeeded: stock reserved and production booked.'
      : `updateOrderStatus refused: ${error ?? res.data.summary}`,
  };
}
