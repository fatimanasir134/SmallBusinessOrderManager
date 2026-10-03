/** GeminiService behaviour with a scripted fake client: no network calls. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApiError,
  type Content,
  FinishReason,
  GenerateContentResponse,
  type GenerateContentParameters,
  type Part,
} from '@google/genai';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { Conversation } from './conversation.js';
import { GeminiService, parseJsonLoose, parseRetryDelaySeconds } from './gemini.js';

// ---------- Fakes ----------

type Step = GenerateContentResponse | Error;

function response(
  parts: Part[],
  extra: { finishReason?: FinishReason; blockReason?: string } = {},
): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [
      { content: { role: 'model', parts }, finishReason: extra.finishReason ?? FinishReason.STOP },
    ],
    ...(extra.blockReason && { promptFeedback: { blockReason: extra.blockReason } }),
  });
}
const text = (t: string) => response([{ text: t }]);
const call = (name: string, args: Record<string, unknown>, id = `call-${name}`) =>
  response([{ functionCall: { id, name, args } }]);
const apiError = (status: number, message = `HTTP ${status}`) => new ApiError({ status, message });

function setup(
  steps: Step[],
  opts: {
    maxAttempts?: number;
    maxDelayMs?: number;
    fallbackModels?: string[];
    minIntervalMs?: number;
  } = {},
) {
  const requests: GenerateContentParameters[] = [];
  const sleeps: number[] = [];
  const service = new GeminiService({
    models: {
      generateContent: async (params) => {
        requests.push(
          structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }),
        );
        assert.ok(params.config?.abortSignal, 'every call has a timeout signal');
        const next = steps.shift();
        if (!next) throw new Error('fake: no more scripted responses');
        if (next instanceof Error) throw next;
        return next;
      },
    },
    model: 'gemini-test',
    fallbackModels: opts.fallbackModels ?? [],
    minIntervalMs: opts.minIntervalMs ?? 0,
    maxAttempts: opts.maxAttempts ?? 3,
    baseDelayMs: 100,
    maxDelayMs: opts.maxDelayMs ?? 5000,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { service, requests, sleeps };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected ${code}`);
}

const lastUserText = (c: Content[] | undefined) =>
  (c ?? []).filter((x) => x.role === 'user').at(-1)?.parts?.[0]?.text ?? '';

// ---------- Tests ----------

describe('helpers', () => {
  it('parses Google retry delays', () => {
    assert.equal(parseRetryDelaySeconds('{"@type":"RetryInfo","retryDelay": "13s"}'), 13);
    assert.equal(parseRetryDelaySeconds('"retryDelay":"0.5s"'), 0.5);
    assert.equal(parseRetryDelaySeconds('quota exceeded'), undefined);
  });
  it('accepts JSON in a code fence', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.throws(() => parseJsonLoose('not json'));
  });
});

describe('GeminiService.generateText', () => {
  it('sends the system instruction and settings, and ignores thought parts', async () => {
    const { service, requests } = setup([
      response([{ text: 'thinking...', thought: true }, { text: 'pong' }]),
    ]);
    const out = await service.generateText({
      label: 't',
      contents: 'ping',
      systemInstruction: 'Be brief.',
      temperature: 0,
    });
    assert.equal(out, 'pong');
    assert.equal(requests[0]!.model, 'gemini-test');
    assert.equal(requests[0]!.config?.systemInstruction, 'Be brief.');
    assert.equal(requests[0]!.config?.temperature, 0);
  });

  it('retries overload (503) with exponential backoff, then succeeds', async () => {
    const { service, requests, sleeps } = setup([apiError(503), apiError(500), text('ok')]);
    assert.equal(await service.generateText({ label: 't', contents: 'x' }), 'ok');
    assert.equal(requests.length, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0]! >= 100 && sleeps[0]! < 200, `first delay ${sleeps[0]}`);
    assert.ok(sleeps[1]! >= 200 && sleeps[1]! < 300, `second delay ${sleeps[1]}`);
  });

  it('gives up after maxAttempts with AI_UNAVAILABLE', async () => {
    const { service, requests } = setup([apiError(503), apiError(503), apiError(503)]);
    await rejectsWith(service.generateText({ label: 't', contents: 'x' }), 'AI_UNAVAILABLE');
    assert.equal(requests.length, 3);
  });

  it("waits for the server's retryDelay on a rate limit", async () => {
    const { service, sleeps } = setup([
      apiError(429, '{"error":{"details":[{"retryDelay":"2s"}]}}'),
      text('ok'),
    ]);
    assert.equal(await service.generateText({ label: 't', contents: 'x' }), 'ok');
    assert.deepEqual(sleeps, [2000]);
  });

  it('fails fast with AI_RATE_LIMITED when the suggested wait is too long', async () => {
    const { service, requests } = setup([apiError(429, '"retryDelay": "120s"')]);
    const err = await rejectsWith(
      service.generateText({ label: 't', contents: 'x' }),
      'AI_RATE_LIMITED',
    );
    assert.equal(err.status, 429);
    assert.deepEqual(err.details, { retryAfterSeconds: 120 });
    assert.equal(requests.length, 1);
  });

  it('retries timeouts and reports AI_TIMEOUT if they persist', async () => {
    const timeout = () =>
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    const { service, requests } = setup([timeout(), timeout(), timeout()]);
    const err = await rejectsWith(
      service.generateText({ label: 't', contents: 'x' }),
      'AI_TIMEOUT',
    );
    assert.equal(err.status, 504);
    assert.equal(requests.length, 3);
  });

  it('retries network failures', async () => {
    const { service } = setup([new TypeError('fetch failed'), text('ok')]);
    assert.equal(await service.generateText({ label: 't', contents: 'x' }), 'ok');
  });

  it('does not retry a bad API key or a missing model', async () => {
    const auth = setup([apiError(403)]);
    const e1 = await rejectsWith(
      auth.service.generateText({ label: 't', contents: 'x' }),
      'AI_ERROR',
    );
    assert.match(e1.message, /API key/);
    assert.equal(auth.requests.length, 1);

    const missing = setup([apiError(404, 'models/gemini-test is no longer available')]);
    const e2 = await rejectsWith(
      missing.service.generateText({ label: 't', contents: 'x' }),
      'AI_ERROR',
    );
    assert.match(e2.message, /gemini-test.*GEMINI_MODEL/);
  });

  it('reports blocked prompts and responses without retrying', async () => {
    const prompt = setup([response([], { blockReason: 'SAFETY' })]);
    await rejectsWith(prompt.service.generateText({ label: 't', contents: 'x' }), 'AI_BLOCKED');
    assert.equal(prompt.requests.length, 1);

    const answer = setup([response([{ text: 'partial' }], { finishReason: FinishReason.SAFETY })]);
    await rejectsWith(answer.service.generateText({ label: 't', contents: 'x' }), 'AI_BLOCKED');
  });

  it('explains an answer cut off by the token limit', async () => {
    const { service } = setup([response([], { finishReason: FinishReason.MAX_TOKENS })]);
    const err = await rejectsWith(
      service.generateText({ label: 't', contents: 'x' }),
      'AI_INVALID_RESPONSE',
    );
    assert.match(err.message, /maxOutputTokens/);
  });

  it('retries a malformed function call', async () => {
    const { service } = setup([
      response([], { finishReason: FinishReason.MALFORMED_FUNCTION_CALL }),
      text('ok'),
    ]);
    assert.equal(await service.generateText({ label: 't', contents: 'x' }), 'ok');
  });
});

describe('GeminiService.generateStructured', () => {
  const schema = z.object({ sku: z.string(), quantity: z.number().int().positive() });

  it('requests JSON with the schema and returns validated data', async () => {
    const { service, requests } = setup([text('{"sku":"STK-PINK","quantity":3}')]);
    const r = await service.generateStructured({ label: 't', contents: 'x', schema });
    assert.deepEqual(r.data, { sku: 'STK-PINK', quantity: 3 });
    assert.equal(r.repaired, false);
    const cfg = requests[0]!.config!;
    assert.equal(cfg.responseMimeType, 'application/json');
    const json = cfg.responseJsonSchema as { type: string; required: string[] };
    assert.equal(json.type, 'object');
    assert.deepEqual(json.required.sort(), ['quantity', 'sku']);
  });

  it('repairs malformed JSON by telling the model what went wrong', async () => {
    const { service, requests } = setup([
      text('{"sku": "STK-PINK", quantity: 3'),
      text('{"sku":"STK-PINK","quantity":3}'),
    ]);
    const r = await service.generateStructured({ label: 't', contents: 'x', schema });
    assert.equal(r.repaired, true);
    assert.match(lastUserText(requests[1]!.contents as Content[]), /not valid JSON/);
  });

  it('repairs schema violations and includes the failing fields', async () => {
    const { service, requests } = setup([
      text('{"sku":"STK-PINK","quantity":-1}'),
      text('{"sku":"STK-PINK","quantity":1}'),
    ]);
    const r = await service.generateStructured({ label: 't', contents: 'x', schema });
    assert.equal(r.data.quantity, 1);
    assert.match(lastUserText(requests[1]!.contents as Content[]), /quantity/);
  });

  it('gives up with AI_INVALID_RESPONSE when the repair also fails', async () => {
    const { service, requests } = setup([text('nope'), text('{"sku":1}')]);
    const err = await rejectsWith(
      service.generateStructured({ label: 't', contents: 'x', schema }),
      'AI_INVALID_RESPONSE',
    );
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(err.details), /sku/);
  });
});

describe('GeminiService.runTools', () => {
  const declarations = [
    { name: 'checkInventory', description: 'stock', parametersJsonSchema: { type: 'object' } },
  ];

  it('runs requested tools and returns their results to the model', async () => {
    const executed: unknown[] = [];
    const { service, requests } = setup([
      call('checkInventory', { items: [{ productId: 1, quantity: 3 }] }),
      text('2 in stock, 1 to make.'),
    ]);
    const r = await service.runTools({
      label: 't',
      contents: 'check stock',
      declarations,
      execute: async (name, args) => {
        executed.push([name, args]);
        return { ok: true, result: { fromStock: 2, toProduce: 1 } };
      },
    });
    assert.equal(r.text, '2 in stock, 1 to make.');
    assert.equal(r.steps, 2);
    assert.deepEqual(executed, [['checkInventory', { items: [{ productId: 1, quantity: 3 }] }]]);
    assert.equal(r.toolCalls[0]!.ok, true);

    // Second request carries the model's call and our functionResponse (with the call id).
    const sent = requests[1]!.contents as Content[];
    const fr = sent.at(-1)!.parts![0]!.functionResponse!;
    assert.equal(fr.id, 'call-checkInventory');
    assert.deepEqual(fr.response, { result: { fromStock: 2, toProduce: 1 } });
    assert.deepEqual(
      (requests[0]!.config!.tools as { functionDeclarations: unknown[] }[])[0]!
        .functionDeclarations,
      declarations,
    );
  });

  it('passes tool errors back so the model can react', async () => {
    const { service, requests } = setup([call('checkInventory', {}), text('Which product?')]);
    const r = await service.runTools({
      label: 't',
      contents: 'x',
      declarations,
      execute: async () => ({
        ok: false,
        error: { code: 'INVALID_ARGUMENTS', message: 'items: Required' },
      }),
    });
    assert.equal(r.toolCalls[0]!.ok, false);
    const fr = (requests[1]!.contents as Content[]).at(-1)!.parts![0]!.functionResponse!;
    assert.deepEqual(fr.response, {
      error: { code: 'INVALID_ARGUMENTS', message: 'items: Required' },
    });
  });

  it('refuses tools that were not offered, without executing anything', async () => {
    let executed = false;
    const { service } = setup([
      call('updateOrderStatus', { orderId: 1, status: 'confirmed' }),
      text('Cannot do that.'),
    ]);
    const r = await service.runTools({
      label: 't',
      contents: 'x',
      declarations,
      execute: async () => {
        executed = true;
        return { ok: true, result: null };
      },
    });
    assert.equal(executed, false);
    assert.equal(r.toolCalls[0]!.ok, false);
    assert.match(JSON.stringify(r.toolCalls[0]!.response), /UNKNOWN_TOOL/);
  });

  it('returns validated JSON when an output schema is given, repairing once if needed', async () => {
    const outputSchema = z.object({ fromStock: z.number().int(), toProduce: z.number().int() });
    const { service, requests } = setup([
      call('checkInventory', { items: [] }),
      text('{"fromStock": "two"}'),
      text('{"fromStock": 2, "toProduce": 1}'),
    ]);
    const r = await service.runTools({
      label: 't',
      contents: 'x',
      declarations,
      outputSchema,
      execute: async () => ({ ok: true, result: { fromStock: 2, toProduce: 1 } }),
    });
    assert.deepEqual(r.data, { fromStock: 2, toProduce: 1 });
    assert.equal(r.repaired, true);
    assert.equal(r.steps, 3);
    assert.equal(requests[0]!.config!.responseMimeType, 'application/json');
    assert.ok(requests[0]!.config!.tools, 'tools and schema are sent together');
  });

  it('stops a runaway loop after maxSteps', async () => {
    const { service } = setup([
      call('checkInventory', {}),
      call('checkInventory', {}),
      call('checkInventory', {}),
    ]);
    await rejectsWith(
      service.runTools({
        label: 't',
        contents: 'x',
        declarations,
        maxSteps: 2,
        execute: async () => ({ ok: true, result: {} }),
      }),
      'AI_INVALID_RESPONSE',
    );
  });
});

describe('Conversation', () => {
  it('keeps context across turns and only records successful turns', async () => {
    const { service, requests } = setup(
      [
        text('How many would you like?'),
        apiError(400, 'bad'),
        text('{"sku":"STK-PINK","quantity":3}'),
      ],
      { maxAttempts: 1 },
    );
    const convo = new Conversation({
      label: 'chat',
      systemInstruction: 'You take orders.',
      service,
    });

    assert.equal(await convo.say('I want pink stickers'), 'How many would you like?');
    await rejectsWith(convo.say('this one fails'), 'AI_ERROR');
    assert.equal(convo.history.length, 2, 'failed turn not recorded');

    const order = await convo.ask(
      '3 please. Give me the order as JSON.',
      z.object({ sku: z.string(), quantity: z.number() }),
    );
    assert.deepEqual(order, { sku: 'STK-PINK', quantity: 3 });

    const last = requests.at(-1)!;
    const texts = (last.contents as Content[]).map((c) => `${c.role}: ${c.parts![0]!.text}`);
    assert.deepEqual(texts, [
      'user: I want pink stickers',
      'model: How many would you like?',
      'user: 3 please. Give me the order as JSON.',
    ]);
    assert.equal(last.config?.systemInstruction, 'You take orders.');
    assert.equal(convo.history.length, 4);
  });
});

describe('model fallback and pacing (free tier)', () => {
  const quota = () => apiError(429, '{"details":[{"retryDelay":"40000s"}]}');

  it('switches to the next model when the daily quota is used up, and remembers it', async () => {
    const { service, requests } = setup([quota(), text('from fallback'), text('again')], {
      fallbackModels: ['gemini-backup'],
    });
    assert.equal(await service.generateText({ label: 't', contents: 'x' }), 'from fallback');
    assert.equal(await service.generateText({ label: 't', contents: 'y' }), 'again');
    assert.deepEqual(
      requests.map((r) => r.model),
      ['gemini-test', 'gemini-backup', 'gemini-backup'],
      'exhausted model is skipped on later calls',
    );
    const status = service.modelStatus();
    assert.equal(status[0]!.available, false);
    assert.equal(status[0]!.reason, 'AI_RATE_LIMITED');
    assert.equal(service.model, 'gemini-backup');
  });

  it('switches when a model stays overloaded after its retries', async () => {
    const { service, requests } = setup([apiError(503), apiError(503), text('ok')], {
      maxAttempts: 2,
      fallbackModels: ['gemini-backup'],
    });
    assert.equal(await service.generateText({ label: 't', contents: 'x' }), 'ok');
    assert.deepEqual(
      requests.map((q) => q.model),
      ['gemini-test', 'gemini-test', 'gemini-backup'],
    );
  });

  it('reports which model answered', async () => {
    const { service } = setup([quota(), text('{"a":1}')], { fallbackModels: ['gemini-backup'] });
    const r = await service.generateStructured({
      label: 't',
      contents: 'x',
      schema: z.object({ a: z.number() }),
    });
    assert.equal(r.model, 'gemini-backup');
  });

  it('does not switch models for errors that another model would not fix', async () => {
    const { service, requests } = setup([apiError(400, 'bad request')], {
      fallbackModels: ['gemini-backup'],
    });
    await rejectsWith(service.generateText({ label: 't', contents: 'x' }), 'AI_ERROR');
    assert.equal(requests.length, 1);
  });

  it('fails fast without calling Gemini when every model is cooling down', async () => {
    const { service, requests } = setup([quota(), quota()], { fallbackModels: ['gemini-backup'] });
    await rejectsWith(service.generateText({ label: 't', contents: 'x' }), 'AI_RATE_LIMITED');
    const err = await rejectsWith(
      service.generateText({ label: 't', contents: 'y' }),
      'AI_RATE_LIMITED',
    );
    assert.equal(requests.length, 2, 'no request made once all models are exhausted');
    assert.ok((err.details as { retryAfterSeconds: number }).retryAfterSeconds > 30_000);
  });

  it('a transient failure on the last available model does not bench it', async () => {
    const timeout = () =>
      Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' });
    const { service, requests } = setup([timeout(), text('ok')], { maxAttempts: 1 });
    await rejectsWith(service.generateText({ label: 't', contents: 'x' }), 'AI_TIMEOUT');
    assert.equal(service.modelStatus()[0]!.available, true);
    assert.equal(await service.generateText({ label: 't', contents: 'y' }), 'ok');
    assert.equal(requests.length, 2);
  });

  it('spaces out calls to the same model', async () => {
    const { service, sleeps } = setup([text('a'), text('b')], { minIntervalMs: 1000 });
    await service.generateText({ label: 't', contents: 'x' });
    await service.generateText({ label: 't', contents: 'y' });
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! > 900 && sleeps[0]! <= 1000, `waited ${sleeps[0]}`);
  });

  it('replaces thought signatures from another model when a tool loop falls back', async () => {
    const signedCall = Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'c1', name: 'checkInventory', args: {} },
                thoughtSignature: 'sig-from-primary',
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    });
    const { service, requests } = setup([signedCall, quota(), text('done')], {
      fallbackModels: ['gemini-backup'],
    });
    const r = await service.runTools({
      label: 't',
      contents: 'x',
      declarations: [{ name: 'checkInventory', description: 'stock' }],
      execute: async () => ({ ok: true, result: {} }),
    });
    assert.equal(r.model, 'gemini-backup');
    const sigs = (m: GenerateContentParameters) =>
      (m.contents as Content[])
        .flatMap((c) => c.parts ?? [])
        .map((p) => p.thoughtSignature)
        .filter(Boolean);
    assert.deepEqual(sigs(requests[1]!), ['sig-from-primary'], 'same model: signature kept');
    assert.deepEqual(
      sigs(requests[2]!),
      ['skip_thought_signature_validator'],
      'other model: placeholder',
    );
  });
});
