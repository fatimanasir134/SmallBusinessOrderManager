import { Router } from 'express';
import { z } from 'zod';
import { listApprovalQueue } from '../repositories/approvals.js';

export const approvalsRouter = Router();

/** The approval queue: requests waiting for a person (or decided ones, for the audit view). */
approvalsRouter.get('/', async (req, res) => {
  const { status } = z
    .object({
      status: z.enum(['pending', 'approved', 'rejected', 'superseded']).default('pending'),
    })
    .parse(req.query);
  res.json(await listApprovalQueue(status));
});
