import { Router } from 'express';
import { z } from 'zod';
import type { AiExtractDto, AiPingDto } from '@sbom/shared';
import { gemini } from '../ai/gemini.js';
import { todayIso } from '../domain/dates.js';
import { extractOrderInformation } from '../tools/extractOrderInformation.js';

export const aiRouter = Router();

const pingBody = z.object({ prompt: z.string().trim().min(1).max(500).optional() }).default({});

/** Minimal Gemini round-trip, used to verify the API key and model. */
aiRouter.post('/ping', async (req, res) => {
  const { prompt } = pingBody.parse(req.body ?? {});
  const start = Date.now();
  const reply = await gemini().generateText({
    label: 'ping',
    contents: prompt ?? 'Reply with exactly: pong',
    temperature: 0,
    // Generous limit: newer Gemini models spend output tokens on thinking before answering.
    maxOutputTokens: 1024,
  });
  const body: AiPingDto = { model: gemini().model, reply, latencyMs: Date.now() - start };
  res.json(body);
});

const extractBody = z.object({
  message: z.string().trim().min(1, 'message is empty').max(4000, 'message is too long'),
});

/**
 * Development endpoint: send a customer message to Gemini and get structured order information
 * back (validated against the catalogue). Read-only: no order is created.
 */
aiRouter.post('/extract', async (req, res) => {
  const { message } = extractBody.parse(req.body ?? {});
  const today = todayIso();
  const start = Date.now();
  const extraction = await extractOrderInformation.handler({ message }, { actor: 'system', today });
  const body: AiExtractDto = {
    model: gemini().model,
    today,
    latencyMs: Date.now() - start,
    extraction,
  };
  res.json(body);
});
