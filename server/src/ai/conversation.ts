/**
 * Multi-turn context: keeps the history and system instruction so follow-up turns see earlier
 * messages, tool calls, and answers (e.g. a customer replying to a "how many?" question).
 */
import type { Content, FunctionDeclaration } from '@google/genai';
import type { z } from 'zod';
import {
  type GeminiService,
  type ToolCallRecord,
  type ToolExecutor,
  gemini,
  userText,
} from './gemini.js';

export interface ConversationOptions {
  label: string;
  systemInstruction?: string;
  temperature?: number;
  service?: GeminiService;
  /** Start from an earlier conversation (e.g. loaded from the database). */
  history?: Content[];
}

export class Conversation {
  private readonly service: GeminiService;
  private contents: Content[];

  constructor(private readonly opts: ConversationOptions) {
    this.service = opts.service ?? gemini();
    this.contents = [...(opts.history ?? [])];
  }

  /** A copy of the history, safe to store or inspect. */
  get history(): Content[] {
    return structuredClone(this.contents);
  }

  private base() {
    return {
      label: this.opts.label,
      systemInstruction: this.opts.systemInstruction,
      temperature: this.opts.temperature,
    };
  }

  /** Send a message and get a text reply. History is only updated if the call succeeds. */
  async say(message: string): Promise<string> {
    const contents = [...this.contents, userText(message)];
    const text = await this.service.generateText({ ...this.base(), contents });
    this.contents = [...contents, { role: 'model', parts: [{ text }] }];
    return text;
  }

  /** Send a message and get a validated structured reply. */
  async ask<T>(message: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const result = await this.service.generateStructured({
      ...this.base(),
      contents: [...this.contents, userText(message)],
      schema,
    });
    this.contents = result.contents;
    return result.data;
  }

  /** Send a message and let Gemini call tools until it answers. */
  async runTools(
    message: string,
    tools: { declarations: FunctionDeclaration[]; execute: ToolExecutor; maxSteps?: number },
  ): Promise<{ text: string; toolCalls: ToolCallRecord[] }> {
    const result = await this.service.runTools({
      ...this.base(),
      contents: [...this.contents, userText(message)],
      ...tools,
    });
    this.contents = result.contents;
    return { text: result.text, toolCalls: result.toolCalls };
  }
}
