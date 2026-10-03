import type { StatusActor } from '@sbom/shared';
import type { z } from 'zod';

/**
 * Who is calling and when. `actor` is set by the backend (never by the model's arguments),
 * so an agent cannot claim to be a human to approve an order.
 */
export interface ToolContext {
  actor: StatusActor;
  /** 'YYYY-MM-DD', injectable for tests. */
  today: string;
  /** Order being processed, for logging. */
  orderId?: number;
}

export interface ToolDefinition<I = unknown, O = unknown, N extends string = string> {
  name: N;
  /** Shown to Gemini: say what the tool does and when to use it. */
  description: string;
  /** read = no side effects; write = changes the database. */
  access: 'read' | 'write';
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

export function defineTool<I, O, const N extends string>(
  def: ToolDefinition<I, O, N>,
): ToolDefinition<I, O, N> {
  return def;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

/** Tools never throw to the caller: errors come back as data the model can read and react to. */
export type ToolResult<O = unknown> =
  | { ok: true; tool: string; result: O; durationMs: number }
  | { ok: false; tool: string; error: ToolError; durationMs: number };
