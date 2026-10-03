import { Router } from 'express';
import type { HealthDto } from '@sbom/shared';
import { env } from '../config/env.js';
import { pingDb } from '../db/client.js';
import { gemini, isGeminiConfigured } from '../ai/gemini.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const dbOk = await pingDb();
  const body: HealthDto = {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    database: dbOk ? 'ok' : 'error',
    gemini: {
      configured: isGeminiConfigured(),
      model: gemini().model,
      models: gemini().modelStatus(),
    },
    version: env.version,
  };
  res.status(dbOk ? 200 : 503).json(body);
});
