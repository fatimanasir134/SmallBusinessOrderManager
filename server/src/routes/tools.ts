import { Router } from 'express';
import type { ToolInfoDto } from '@sbom/shared';
import { TOOLS } from '../tools/registry.js';

export const toolsRouter = Router();

/** The business tools agents can call, and whether each one writes to the database. */
toolsRouter.get('/', (_req, res) => {
  const body: ToolInfoDto[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    access: t.access,
  }));
  res.json(body);
});
