/**
 * A scripted stand-in for Gemini, for workflow tests. It recognises each agent by its system
 * instruction and, by default, behaves like an honest agent: calls its tool with the arguments
 * from its prompt and reports the tool's result. Tests override individual agents to misbehave.
 */
import {
  type Content,
  FinishReason,
  GenerateContentResponse,
  type GenerateContentParameters,
  type Part,
} from '@google/genai';
import type { RawExtractionDto } from '@sbom/shared';
import { GeminiService } from '../ai/gemini.js';

export type AgentKey =
  'understanding' | 'pricing' | 'inventory' | 'production' | 'communication' | 'order_management';

const AGENT_MARKERS: [AgentKey, string][] = [
  ['understanding', 'Order Understanding Agent'],
  ['pricing', 'Pricing Agent'],
  ['inventory', 'Inventory Agent'],
  ['production', 'Production Agent'],
  ['communication', 'Communication Agent'],
  ['order_management', 'Order Management Agent'],
];

export interface FakeTurn {
  agent: AgentKey;
  /** The first user message (the agent's task, including its JSON input). */
  prompt: string;
  /** JSON parsed from the prompt (from the first "{"). */
  input: any;
  /** Result of the agent's latest tool call, if it has made one. */
  toolResult?: { name: string; response: any };
  contents: Content[];
}

export type Reply = GenerateContentResponse | Error;
export type Handler = (turn: FakeTurn) => Reply;

export const text = (t: string): GenerateContentResponse =>
  Object.assign(new GenerateContentResponse(), {
    candidates: [
      { content: { role: 'model', parts: [{ text: t }] }, finishReason: FinishReason.STOP },
    ],
  });
export const json = (v: unknown) => text(JSON.stringify(v));
export const callTool = (name: string, args: unknown): GenerateContentResponse =>
  Object.assign(new GenerateContentResponse(), {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { id: `c-${name}`, name, args } }] },
        finishReason: FinishReason.STOP,
      },
    ],
  });

const firstJson = (s: string) => {
  const i = s.indexOf('{');
  return i < 0 ? {} : JSON.parse(s.slice(i, s.lastIndexOf('}') + 1));
};

/** Honest default behaviour for each agent. `extraction` is what the understanding agent "reads". */
export function honestAgents(extraction: Partial<RawExtractionDto>): Record<AgentKey, Handler> {
  const raw: RawExtractionDto = {
    customer: { name: null, email: null, phone: null },
    items: [],
    deadlineText: null,
    deadlineDate: null,
    discountRequested: false,
    customization: null,
    otherRequests: null,
    clarificationQuestions: [],
    ...extraction,
  };
  const toolThenReport =
    (tool: string, report: (result: any) => unknown): Handler =>
    (t) =>
      t.toolResult ? json(report(t.toolResult.response.result)) : callTool(tool, t.input);

  return {
    understanding: () => json(raw),
    pricing: toolThenReport('calculateOrderPrice', (q) => ({
      subtotalCents: q.subtotalCents,
      discountCents: q.discountCents,
      surchargeCents: q.surchargeCents,
      totalCents: q.totalCents,
      discountDecision:
        q.discountCents > 0 ? 'applied' : raw.discountRequested ? 'not_eligible' : 'not_requested',
      offerUpsell:
        raw.discountRequested && q.discountCents === 0 && q.discountOpportunities.length > 0,
      explanation: 'Priced from the rules.',
    })),
    // The backend runs checkInventory and puts the result in the prompt.
    inventory: (t) =>
      json({
        canFulfill: t.input.fulfillable,
        fullyInStock: t.input.allInStock,
        route: t.input.fulfillable ? 'continue' : 'insufficient_stock',
        offer: t.input.fulfillable
          ? 'none'
          : t.input.substitutes.length
            ? 'substitute'
            : t.input.lines.some((l: any) => l.requested - l.unfulfillable > 0)
              ? 'partial'
              : 'none',
        summary: 'Checked.',
      }),
    production: toolThenReport('calculateEstimatedCompletion', (e) => ({
      feasible: e.estimatedCompletionDate !== null && e.meetsDeadline !== false,
      estimatedCompletionDate: e.estimatedCompletionDate,
      meetsDeadline: e.meetsDeadline,
      earliestPossibleDate: e.earliestPossibleDate,
      route: e.meetsDeadline === false ? 'propose_alternative' : 'continue',
      alternative: e.meetsDeadline === false ? (e.alternatives[0]?.type ?? null) : null,
      summary: 'Checked.',
    })),
    communication: (t) => {
      const facts = t.input;
      const total = facts.quote?.total ? ` Your total is ${facts.quote.total}.` : '';
      return json({
        subject: 'Your order',
        reply: `Hi! Thanks for your message.${total} Reply to confirm. Petal & Ink Studio`,
      });
    },
    order_management: (t) => {
      if (!t.toolResult) {
        return callTool('updateOrderStatus', {
          orderId: t.input.orderId,
          status: 'confirmed',
          note: t.input.note,
        });
      }
      const r = t.toolResult.response.result;
      return json({
        confirmed: Boolean(r),
        promisedDate: r?.effects?.promisedDate ?? null,
        summary: r ? 'Confirmed.' : 'Could not confirm.',
      });
    },
  };
}

/** A GeminiService whose model is the scripted agents. Records every turn for assertions. */
export function fakeGemini(handlers: Record<AgentKey, Handler>) {
  const turns: FakeTurn[] = [];
  const service = new GeminiService({
    model: 'fake-gemini',
    maxAttempts: 1,
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        const system = String(params.config?.systemInstruction ?? '');
        const agent = AGENT_MARKERS.find(([, m]) => system.includes(m))?.[0];
        if (!agent)
          throw new Error(`fake gemini: unknown agent for instruction "${system.slice(0, 60)}"`);
        const contents = params.contents as Content[];
        const prompt = contents.find((c) => c.role === 'user')?.parts?.[0]?.text ?? '';
        const last = contents.at(-1);
        const fr = last?.parts?.find((p: Part) => p.functionResponse)?.functionResponse;
        const turn: FakeTurn = {
          agent,
          prompt,
          input: firstJson(prompt),
          toolResult: fr ? { name: fr.name!, response: fr.response } : undefined,
          contents,
        };
        turns.push(turn);
        const reply = handlers[agent](turn);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  });
  return { service, turns };
}
