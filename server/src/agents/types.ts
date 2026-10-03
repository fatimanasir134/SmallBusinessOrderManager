/** Types shared by all agents. No runtime imports, so any module can use them without cycles. */
import type { StopReason, Verification } from '@sbom/shared';
import type { GeminiService, ToolCallRecord } from '../ai/gemini.js';

export interface AgentContext {
  ai: GeminiService;
  /** 'YYYY-MM-DD' */
  today: string;
  orderId: number;
  runId: string;
}

export interface AgentOutcome<O> {
  output: O;
  /** One line for the dashboard: what the agent concluded. */
  summary: string;
  decision: 'continue' | 'stop';
  stopReason?: StopReason;
  verification: Verification;
  toolCalls: ToolCallRecord[];
  /** Differences between what the agent said and what the tools returned. */
  discrepancies: string[];
  /** Gemini model that did the reasoning; undefined when a rule handled the step without AI. */
  model?: string;
  /** The route the agent chose (validated against tool results), e.g. 'insufficient_stock'. */
  route: string;
  /** Why: the tool evidence behind the route. */
  routeReason: string;
}

/** Studio name used in prompts and replies. */
export const BUSINESS_NAME = 'Petal & Ink Studio';
