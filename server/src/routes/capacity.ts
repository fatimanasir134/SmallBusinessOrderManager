import { Router } from 'express';
import { z } from 'zod';
import { isValidIsoDay } from '../domain/dates.js';
import { badRequest } from '../lib/errors.js';
import { listCapacity } from '../repositories/capacity.js';

export const capacityRouter = Router();

const isoDate = z.string().refine(isValidIsoDay, 'expected a real date as YYYY-MM-DD');
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

/** Production capacity per day. Defaults to the next 14 days. */
capacityRouter.get('/', async (req, res) => {
  const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
  const from = q.from ?? today();
  const to = q.to ?? addDays(from, 13);
  if (to < from) throw badRequest('`to` must be on or after `from`');
  res.json(await listCapacity(from, to));
});
