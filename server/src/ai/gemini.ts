/**
 * The Gemini service: the only module in the app that talks to an LLM, and the only LLM is Gemini.
 *
 *  - generate()            one call with timeout, retries (rate limits, overload, network), and
 *                          response checks (blocked, empty, cut off)
 *  - generateText()        plain text
 *  - generateStructured()  JSON constrained by a zod schema, parsed and validated, with one
 *                          automatic "repair" turn if the model returns malformed or off-schema JSON
 *  - runTools()            function-calling loop: Gemini proposes calls, the injected executor runs
 *                          them (the business tools validate and enforce rules), results go back
 *  - Conversation          keeps history across turns (see conversation.ts)
 *
 * Free-tier friendly: calls are paced per model (GEMINI_MIN_INTERVAL_MS), and when a model hits its
 * quota or stays overloaded the service falls back to the next model in GEMINI_FALLBACK_MODELS
 * (each model has its own free quota), remembering which models are cooling down.
 *
 * The API key comes from GEMINI_API_KEY and is never logged. Everything is unit-testable by
 * passing a fake `models` client to the constructor.
 */
import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  ThinkingLevel,
} from '@google/genai';
import type { z } from 'zod';
import { env } from '../config/env.js';
import {
  type AppError,
  aiBlocked,
  aiError,
  aiInvalidResponse,
  aiNotConfigured,
  aiRateLimited,
  aiTimeout,
  aiUnavailable,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { toGeminiJsonSchema } from './schema.js';

// ---------- Types ----------

/** The slice of the SDK we use; tests pass a fake. */
export interface GeminiModels {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

export interface GeminiServiceOptions {
  models?: GeminiModels;
  /** Defaults to GEMINI_API_KEY; null simulates a missing key. */
  apiKey?: string | null;
  /** Primary model (default GEMINI_MODEL). */
  model?: string;
  /** Tried in order when the primary is rate-limited or unavailable (default GEMINI_FALLBACK_MODELS). */
  fallbackModels?: string[];
  /** Minimum gap between calls to the same model, to stay under per-minute limits. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** First retry delay; doubles each attempt (plus jitter). */
  baseDelayMs?: number;
  /** Longest we will wait before a retry (including a server-suggested delay). */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GenerateRequest {
  /** Short name for logs, e.g. 'intake'. */
  label: string;
  /** A user prompt, or a full conversation. */
  contents: string | Content[];
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** How much the model reasons before answering. Lower is faster and cheaper; simple extraction needs little. */
  thinking?: 'minimal' | 'low' | 'medium' | 'high';
  model?: string;
  /** Extra SDK config (tools, responseJsonSchema, ...). */
  config?: GenerateContentConfig;
}

export interface StructuredRequest<T> extends Omit<GenerateRequest, 'config'> {
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** How many times to ask the model to fix invalid JSON (default 1). */
  repairAttempts?: number;
}

export interface StructuredResult<T> {
  data: T;
  /** The model that produced the answer (may be a fallback). */
  model: string;
  /** True if the first answer was invalid and a repair turn fixed it. */
  repaired: boolean;
  /** The conversation including the model's final JSON answer. */
  contents: Content[];
}

export interface ToolCallRecord {
  name: string;
  /** Who made the call: the model (function calling) or the backend on the agent's behalf. */
  source?: 'model' | 'backend';
  args: unknown;
  ok: boolean;
  /** What was sent back to the model. */
  response: Record<string, unknown>;
  durationMs: number;
}

/** Runs one tool call. Must not throw: return { ok: false, error } instead. */
export type ToolExecutor = (
  name: string,
  args: unknown,
) => Promise<{ ok: true; result: unknown } | { ok: false; error: unknown }>;

export interface ToolRunRequest<T = never> extends Omit<GenerateRequest, 'config'> {
  declarations: FunctionDeclaration[];
  execute: ToolExecutor;
  /** Model turns allowed before giving up (each turn may contain several calls). Default 6. */
  maxSteps?: number;
  /**
   * If set, the final answer must be JSON matching this schema (Gemini enforces it alongside the
   * tools); it is validated, with repair turns like generateStructured.
   */
  outputSchema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  repairAttempts?: number;
}

export interface ToolRunResult<T = never> {
  text: string;
  /** The model that produced the final answer (may be a fallback). */
  model: string;
  /** The validated final answer when `outputSchema` was given. */
  data: T;
  toolCalls: ToolCallRecord[];
  /** Model calls made (tool turns + final answer + repairs). */
  steps: number;
  repaired: boolean;
  /** Full conversation, including tool calls and results, for follow-up turns. */
  contents: Content[];
}

// ---------- Helpers ----------

const BLOCKED_FINISH_REASONS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const THINKING_LEVELS = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} as const;

export const userText = (text: string): Content => ({ role: 'user', parts: [{ text }] });
const toContents = (c: string | Content[]): Content[] =>
  typeof c === 'string' ? [userText(c)] : [...c];

/** Text of the first candidate, ignoring "thought" parts. */
function responseText(res: GenerateContentResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/** Accept bare JSON, or JSON wrapped in a ```json fence. */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1]! : text);
}

/** Google returns e.g. `"retryDelay": "13s"` (RetryInfo) on 429s. */
export function parseRetryDelaySeconds(message: string): number | undefined {
  const m = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Number(m[1]) : undefined;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      /timed? ?out|aborted/i.test(err.message))
  );
}

function isNetworkError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(err.message)
  );
}

/** A failure we classified, plus whether another attempt might succeed. */
class AttemptError extends Error {
  constructor(
    readonly appError: AppError,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    /** Set when the problem is specific to this model: rest it this long and try another model. */
    readonly cooldownMs?: number,
  ) {
    super(appError.message);
  }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * Gemini 3 rejects thought signatures created by a different model. Google documents this value
 * for conversations moved between models.
 */
const FOREIGN_SIGNATURE = 'skip_thought_signature_validator';

export interface ModelStatus {
  model: string;
  available: boolean;
  /** ISO time the model is expected back, when cooling down. */
  until: string | null;
  reason: string | null;
}

// ---------- Service ----------

export class GeminiService {
  private readonly models?: GeminiModels;
  private readonly opts: Required<
    Omit<GeminiServiceOptions, 'models' | 'model' | 'fallbackModels' | 'apiKey'>
  >;
  /** Primary first, then fallbacks. */
  private readonly chain: string[];
  private readonly cooldowns = new Map<string, { until: number; reason: string }>();
  private readonly nextSlot = new Map<string, number>();
  /** Which model produced each model turn, so signatures can be fixed when the model changes. */
  private readonly turnOrigin = new WeakMap<Content, string>();
  private readonly apiKey: string | undefined;
  private ownClient?: GoogleGenAI;

  constructor(options: GeminiServiceOptions = {}) {
    this.models = options.models;
    this.apiKey = options.apiKey === undefined ? env.GEMINI_API_KEY : (options.apiKey ?? undefined);
    const primary = options.model ?? env.GEMINI_MODEL;
    const fallbacks = options.fallbackModels ?? (options.model ? [] : env.geminiFallbackModels);
    this.chain = [...new Set([primary, ...fallbacks])];
    this.opts = {
      minIntervalMs: options.minIntervalMs ?? (options.models ? 0 : env.GEMINI_MIN_INTERVAL_MS),
      timeoutMs: options.timeoutMs ?? env.GEMINI_TIMEOUT_MS,
      maxAttempts: options.maxAttempts ?? env.GEMINI_MAX_ATTEMPTS,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 20_000,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /** The model the next call will use (the first one not cooling down). */
  get model(): string {
    return this.availableModels()[0] ?? this.chain[0]!;
  }

  /** Every configured model and whether it is usable right now (for the health endpoint). */
  modelStatus(): ModelStatus[] {
    const now = Date.now();
    return this.chain.map((model) => {
      const c = this.cooldowns.get(model);
      const cooling = c !== undefined && c.until > now;
      return {
        model,
        available: !cooling,
        until: cooling ? new Date(c.until).toISOString() : null,
        reason: cooling ? c.reason : null,
      };
    });
  }

  private availableModels(): string[] {
    const now = Date.now();
    return this.chain.filter((m) => (this.cooldowns.get(m)?.until ?? 0) <= now);
  }

  /** Wait so calls to one model are at least minIntervalMs apart. */
  private async pace(model: string): Promise<void> {
    if (this.opts.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(model) ?? 0);
    this.nextSlot.set(model, slot + this.opts.minIntervalMs);
    if (slot > now) await this.opts.sleep(slot - now);
  }

  /** Replace thought signatures that another model created, so this model accepts the history. */
  private forModel(contents: Content[], model: string): Content[] {
    return contents.map((c) => {
      const origin = this.turnOrigin.get(c);
      if (!origin || origin === model || !c.parts?.some((p) => p.thoughtSignature)) return c;
      return {
        ...c,
        parts: c.parts.map((p) =>
          p.thoughtSignature ? { ...p, thoughtSignature: FOREIGN_SIGNATURE } : p,
        ),
      };
    });
  }

  private client(): GeminiModels {
    if (this.models) return this.models;
    if (!this.apiKey) throw aiNotConfigured();
    if (this.apiKey === env.GEMINI_API_KEY) {
      sdkClient ??= new GoogleGenAI({ apiKey: this.apiKey });
      return sdkClient.models;
    }
    this.ownClient ??= new GoogleGenAI({ apiKey: this.apiKey });
    return this.ownClient.models;
  }

  /** One model call with pacing, timeout, retries, model fallback, and response checks. */
  async generate(req: GenerateRequest): Promise<GenerateContentResponse> {
    return (await this.call(req)).res;
  }

  /** Like generate(), but also says which model answered. */
  private async call(
    req: GenerateRequest,
  ): Promise<{ res: GenerateContentResponse; model: string }> {
    const models = this.client();
    const candidates = req.model ? [req.model] : this.availableModels();
    if (candidates.length === 0) {
      const soonest = Math.min(...[...this.cooldowns.values()].map((c) => c.until));
      throw aiRateLimited(Math.max(1, (soonest - Date.now()) / 1000));
    }

    let lastError: AppError | undefined;
    for (const model of candidates) {
      try {
        return { res: await this.callModel(models, model, req), model };
      } catch (err) {
        if (!(err instanceof AttemptError)) throw err;
        lastError = err.appError;
        if (err.cooldownMs === undefined) throw err.appError; // not model-specific: don't switch
        const next = candidates[candidates.indexOf(model) + 1];
        // A short, transient problem (timeout, overload) only benches a model while another can take
        // over; otherwise the very next request would fail fast for no reason. Quota exhaustion and
        // unknown models are benched regardless.
        const transient = err.cooldownMs <= MINUTE;
        if (transient && !next) throw err.appError;
        const until = Date.now() + Math.min(err.cooldownMs, DAY);
        this.cooldowns.set(model, { until, reason: err.appError.code });
        logger.warn(next ? 'gemini model unavailable, falling back' : 'gemini model unavailable', {
          component: 'gemini',
          label: req.label,
          model,
          code: err.appError.code,
          coolingDownUntil: new Date(until).toISOString(),
          next: next ?? null,
        });
      }
    }
    throw lastError!;
  }

  /** Attempts against one model. Throws the last AttemptError when it gives up. */
  private async callModel(
    models: GeminiModels,
    model: string,
    req: GenerateRequest,
  ): Promise<GenerateContentResponse> {
    const log = logger.child({ component: 'gemini', label: req.label, model });
    const config: GenerateContentConfig = {
      ...req.config,
      ...(req.systemInstruction && { systemInstruction: req.systemInstruction }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.maxOutputTokens !== undefined && { maxOutputTokens: req.maxOutputTokens }),
      ...(req.thinking && { thinkingConfig: { thinkingLevel: THINKING_LEVELS[req.thinking] } }),
    };
    const contents = this.forModel(toContents(req.contents), model);

    for (let attempt = 1; ; attempt++) {
      await this.pace(model);
      const start = Date.now();
      try {
        let res: GenerateContentResponse;
        try {
          res = await models.generateContent({
            model,
            contents,
            config: { ...config, abortSignal: AbortSignal.timeout(this.opts.timeoutMs) },
          });
        } catch (err) {
          throw this.classify(err, model);
        }
        this.checkResponse(res);
        log.debug('gemini call ok', {
          attempt,
          latencyMs: Date.now() - start,
          promptTokens: res.usageMetadata?.promptTokenCount,
          outputTokens: res.usageMetadata?.candidatesTokenCount,
          thinkingTokens: res.usageMetadata?.thoughtsTokenCount,
          finishReason: res.candidates?.[0]?.finishReason,
        });
        return res;
      } catch (err) {
        if (!(err instanceof AttemptError)) throw err;
        const latencyMs = Date.now() - start;
        const canRetry = err.retryable && attempt < this.opts.maxAttempts;
        const delay = canRetry ? this.retryDelay(attempt, err.retryAfterMs) : undefined;
        log.warn('gemini call failed', {
          attempt,
          code: err.appError.code,
          error: err.message,
          latencyMs,
          retryInMs: delay ?? null,
        });
        if (delay === undefined) throw err;
        await this.opts.sleep(delay);
      }
    }
  }

  /** Exponential backoff with jitter; honour the server's suggested delay when it's reasonable. */
  private retryDelay(attempt: number, retryAfterMs?: number): number | undefined {
    if (retryAfterMs !== undefined) {
      return retryAfterMs <= this.opts.maxDelayMs ? retryAfterMs : undefined; // too long: give up now
    }
    const backoff = this.opts.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(backoff + Math.random() * this.opts.baseDelayMs * 0.25, this.opts.maxDelayMs);
  }

  /** Turn an SDK/network error into an AppError and decide if it's worth retrying. */
  private classify(err: unknown, model: string): AttemptError {
    if (err instanceof ApiError) {
      const s = err.status;
      if (s === 429) {
        const retryAfter = parseRetryDelaySeconds(err.message);
        const retryAfterMs = retryAfter === undefined ? undefined : retryAfter * 1000;
        // A long suggested wait means a daily quota: rest this model until then.
        return new AttemptError(
          aiRateLimited(retryAfter),
          true,
          retryAfterMs,
          retryAfterMs ?? MINUTE,
        );
      }
      if (s === 400 && /api key/i.test(err.message)) {
        return new AttemptError(
          aiError('Gemini rejected the API key. Check GEMINI_API_KEY.'),
          false,
        );
      }
      if (s === 401 || s === 403) {
        return new AttemptError(
          aiError('Gemini rejected the API key. Check GEMINI_API_KEY.'),
          false,
        );
      }
      if (s === 404) {
        // Google's message explains why (e.g. model retired for new keys) and often names a replacement.
        return new AttemptError(
          aiError(`Gemini model "${model}" is not available. Check GEMINI_MODEL.`, {
            reason: err.message,
          }),
          false,
          undefined,
          DAY,
        );
      }
      if (s === 400) {
        return new AttemptError(
          aiError('Gemini rejected the request.', { reason: err.message }),
          false,
        );
      }
      if (RETRYABLE_STATUS.has(s)) {
        return new AttemptError(
          aiUnavailable(
            s === 503 ? 'Gemini is overloaded right now. Try again shortly.' : undefined,
          ),
          true,
          undefined,
          MINUTE,
        );
      }
      return new AttemptError(aiError('Gemini request failed', { status: s }), false);
    }
    if (isTimeout(err)) {
      return new AttemptError(aiTimeout(this.opts.timeoutMs), true, undefined, MINUTE);
    }
    if (isNetworkError(err))
      return new AttemptError(aiUnavailable('Could not reach the Gemini API.'), true);
    return new AttemptError(
      aiError('Unexpected error calling Gemini', {
        message: err instanceof Error ? err.message : String(err),
      }),
      false,
    );
  }

  /** Reject blocked, empty, or broken responses. */
  private checkResponse(res: GenerateContentResponse): void {
    const blockReason = res.promptFeedback?.blockReason;
    if (blockReason) throw new AttemptError(aiBlocked(`prompt blocked: ${blockReason}`), false);

    const candidate = res.candidates?.[0];
    if (!candidate)
      throw new AttemptError(aiInvalidResponse('Gemini returned no candidates'), true);

    const reason = candidate.finishReason;
    if (reason && BLOCKED_FINISH_REASONS.has(reason)) {
      throw new AttemptError(aiBlocked(`response stopped: ${reason}`), false);
    }
    if (reason === FinishReason.MALFORMED_FUNCTION_CALL) {
      // A model glitch: asking again usually works.
      throw new AttemptError(aiInvalidResponse('Gemini produced a malformed function call'), true);
    }
  }

  /** Plain text answer. */
  async generateText(req: GenerateRequest): Promise<string> {
    return (await this.textCall(req)).text;
  }

  private async textCall(req: GenerateRequest): Promise<{ text: string; model: string }> {
    const { res, model } = await this.call(req);
    const text = responseText(res);
    if (!text) {
      const cutOff = res.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS;
      throw aiInvalidResponse(
        cutOff
          ? 'Gemini ran out of output tokens before answering. Raise maxOutputTokens.'
          : 'Gemini returned an empty response',
      );
    }
    return { text, model };
  }

  /**
   * JSON answer constrained by `schema`. Gemini is told the JSON Schema; the reply is parsed and
   * validated with zod. If that fails, the error is sent back once so the model can correct itself.
   */
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const { schema, repairAttempts = 1, ...rest } = req;
    const config: GenerateContentConfig = {
      responseMimeType: 'application/json',
      responseJsonSchema: toGeminiJsonSchema(schema),
    };
    const contents = toContents(req.contents);

    for (let attempt = 0; ; attempt++) {
      const { text, model } = await this.textCall({ ...rest, contents, config });
      contents.push({ role: 'model', parts: [{ text }] });

      const check = validateJson(text, schema);
      if (check.ok) return { data: check.data, model, repaired: attempt > 0, contents };
      const { problem, details } = check;

      if (attempt >= repairAttempts) {
        throw aiInvalidResponse(`Gemini returned invalid structured output (${req.label})`, {
          problem,
          details,
        });
      }
      logger.warn('gemini structured output invalid, asking for a fix', {
        component: 'gemini',
        label: req.label,
        problem,
      });
      contents.push(userText(repairMessage(problem)));
    }
  }

  /**
   * Function-calling loop. Gemini proposes calls; `execute` runs them (with validation and
   * permissions enforced by the backend) and the results are sent back, until the model answers
   * or `maxSteps` is reached. With `outputSchema`, the answer is validated JSON.
   */
  async runTools<T = never>(req: ToolRunRequest<T>): Promise<ToolRunResult<T>> {
    const { declarations, execute, maxSteps = 6, outputSchema, repairAttempts = 1, ...rest } = req;
    const contents = toContents(req.contents);
    const toolCalls: ToolCallRecord[] = [];
    const allowed = new Set(declarations.map((d) => d.name));
    const config: GenerateContentConfig = {
      tools: [{ functionDeclarations: declarations }],
      ...(outputSchema && {
        responseMimeType: 'application/json',
        responseJsonSchema: toGeminiJsonSchema(outputSchema),
      }),
    };
    let repairs = 0;
    let lastModel = this.model;

    for (let step = 1; step <= maxSteps; step++) {
      const { res, model } = await this.call({ ...rest, contents, config });
      lastModel = model;
      const modelContent = res.candidates![0]!.content ?? { role: 'model', parts: [] };
      // Keep the model turn exactly as returned (it may carry thought signatures Gemini needs back).
      const turn: Content = { ...modelContent, role: 'model' };
      this.turnOrigin.set(turn, model);
      contents.push(turn);

      const calls: FunctionCall[] = res.functionCalls ?? [];
      if (calls.length === 0) {
        const text = responseText(res);
        if (!text) throw aiInvalidResponse('Gemini ended the tool loop without an answer');
        if (!outputSchema) {
          return {
            text,
            model: lastModel,
            data: undefined as T,
            toolCalls,
            steps: step,
            repaired: false,
            contents,
          };
        }
        const check = validateJson(text, outputSchema);
        if (check.ok) {
          return {
            text,
            model: lastModel,
            data: check.data,
            toolCalls,
            steps: step,
            repaired: repairs > 0,
            contents,
          };
        }
        if (repairs >= repairAttempts) {
          throw aiInvalidResponse(`Gemini returned invalid structured output (${req.label})`, {
            problem: check.problem,
            details: check.details,
          });
        }
        repairs++;
        contents.push(userText(repairMessage(check.problem)));
        continue;
      }

      const parts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? '';
        const start = Date.now();
        const outcome = allowed.has(name)
          ? await execute(name, call.args ?? {})
          : {
              ok: false as const,
              error: { code: 'UNKNOWN_TOOL', message: `Tool "${name}" is not available here.` },
            };
        const response = outcome.ok ? { result: outcome.result } : { error: outcome.error };
        toolCalls.push({
          name,
          source: 'model',
          args: call.args ?? {},
          ok: outcome.ok,
          response,
          durationMs: Date.now() - start,
        });
        parts.push({ functionResponse: { id: call.id, name, response } });
      }
      contents.push({ role: 'user', parts });
    }
    throw aiInvalidResponse(`Gemini did not finish within ${maxSteps} tool steps`, {
      toolCalls: toolCalls.map((c) => c.name),
    });
  }
}

type JsonCheck<T> = { ok: true; data: T } | { ok: false; problem: string; details: unknown };

/** Parse and validate a JSON answer, describing what is wrong if it fails. */
function validateJson<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): JsonCheck<T> {
  try {
    const parsed = schema.safeParse(parseJsonLoose(text));
    if (parsed.success) return { ok: true, data: parsed.data };
    return {
      ok: false,
      details: parsed.error.issues,
      problem: parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  } catch {
    return { ok: false, problem: 'it is not valid JSON', details: { sample: text.slice(0, 300) } };
  }
}

const repairMessage = (problem: string) =>
  `Your previous reply was rejected because ${problem}. ` +
  'Reply again with only the corrected JSON that matches the schema.';

let sdkClient: GoogleGenAI | undefined;
let defaultService: GeminiService | undefined;

/** The shared service, configured from the environment. */
export function gemini(): GeminiService {
  defaultService ??= new GeminiService();
  return defaultService;
}

export const isGeminiConfigured = (): boolean => Boolean(env.GEMINI_API_KEY);
export const geminiModel = (): string => env.GEMINI_MODEL;
