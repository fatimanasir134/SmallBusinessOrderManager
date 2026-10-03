/**
 * The single way tools are run, whether Gemini asked for them (function calling) or the
 * workflow calls them directly. The model only proposes a call; this code validates the
 * arguments, enforces permissions, runs the business logic, and returns a structured result.
 */
import type { FunctionDeclaration } from '@google/genai';
import type { ToolExecutor } from '../ai/gemini.js';
import { toGeminiJsonSchema } from '../ai/schema.js';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { calculateEstimatedCompletion } from './calculateEstimatedCompletion.js';
import { calculateOrderPrice } from './calculateOrderPrice.js';
import { checkInventory } from './checkInventory.js';
import { checkProductionCapacity } from './checkProductionCapacity.js';
import { createOrder } from './createOrder.js';
import { extractOrderInformation } from './extractOrderInformation.js';
import { getCustomerInformation } from './getCustomerInformation.js';
import { getProductInformation } from './getProductInformation.js';
import { restockProduct } from './restockProduct.js';
import { updateOrderStatus } from './updateOrderStatus.js';
import type { ToolContext, ToolDefinition, ToolError, ToolResult } from './types.js';

export const TOOLS = [
  extractOrderInformation,
  calculateOrderPrice,
  checkInventory,
  checkProductionCapacity,
  calculateEstimatedCompletion,
  createOrder,
  updateOrderStatus,
  getCustomerInformation,
  getProductInformation,
  restockProduct,
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];

const byName = new Map<string, ToolDefinition<unknown, unknown>>(
  TOOLS.map((t) => [t.name, t as unknown as ToolDefinition<unknown, unknown>]),
);

export function getTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return byName.get(name);
}

function toToolError(err: unknown): ToolError {
  if (err instanceof ZodError) {
    return {
      code: 'INVALID_ARGUMENTS',
      message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      details: err.issues,
    };
  }
  if (err instanceof AppError)
    return { code: err.code, message: err.message, details: err.details };
  return {
    code: 'TOOL_FAILED',
    message: 'The tool failed unexpectedly. Try again or ask a person.',
  };
}

/** Validate and run a tool. Never throws: failures come back as { ok: false, error }. */
export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const start = Date.now();
  const log = logger.child({
    component: 'tools',
    tool: name,
    actor: ctx.actor,
    orderId: ctx.orderId,
  });
  const tool = byName.get(name);
  if (!tool) {
    return {
      ok: false,
      tool: name,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `No tool named "${name}". Available: ${[...byName.keys()].join(', ')}`,
      },
      durationMs: 0,
    };
  }

  try {
    const input = tool.input.parse(args ?? {});
    const result = await tool.handler(input, ctx);
    const durationMs = Date.now() - start;
    log.debug('tool ok', { durationMs });
    return { ok: true, tool: name, result, durationMs };
  } catch (err) {
    const error = toToolError(err);
    const durationMs = Date.now() - start;
    if (error.code === 'TOOL_FAILED') log.error('tool crashed', { err, durationMs });
    else log.info('tool rejected', { code: error.code, message: error.message, durationMs });
    return { ok: false, tool: name, error, durationMs };
  }
}

/** Gemini function declarations, generated from the same zod schemas used for validation. */
export function geminiFunctionDeclarations(names?: readonly ToolName[]): FunctionDeclaration[] {
  return TOOLS.filter((t) => !names || names.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: toGeminiJsonSchema(t.input),
  }));
}

/**
 * What an agent hands to GeminiService.runTools: the declarations for its tools, and an executor
 * bound to the caller's context (so `actor` comes from the backend, not from the model).
 */
export function toolsForGemini(
  names: readonly ToolName[],
  ctx: ToolContext,
): { declarations: FunctionDeclaration[]; execute: ToolExecutor } {
  return {
    declarations: geminiFunctionDeclarations(names),
    execute: async (name, args) => {
      const r = await executeTool(name, args, ctx);
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    },
  };
}
