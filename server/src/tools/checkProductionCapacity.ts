import { z } from 'zod';
import { addDays } from '../domain/dates.js';
import { planProduction } from '../domain/production.js';
import { badRequest } from '../lib/errors.js';
import { listCapacity } from '../repositories/capacity.js';
import { isoDay } from './schemas.js';
import { defineTool } from './types.js';

/** How far ahead we look for free capacity. */
export const PLANNING_HORIZON_DAYS = 60;

const input = z.object({
  requiredMinutes: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .describe('Production minutes needed (from checkInventory: totalProductionMinutes)'),
  deadline: isoDay.optional().describe('Work must be finished on or before this day'),
  startDay: isoDay.optional().describe('Earliest day to schedule work; defaults to today'),
});

export const checkProductionCapacity = defineTool({
  name: 'checkProductionCapacity',
  description:
    'Check whether the studio has enough free production time. Fits the required minutes into ' +
    'free capacity, earliest day first, and reports the schedule, the completion day, and whether ' +
    'it meets the deadline. Also lists free minutes per day. Does not book anything.',
  access: 'read',
  input,
  handler: async ({ requiredMinutes, deadline, startDay }, ctx) => {
    const from = startDay ?? ctx.today;
    if (from < ctx.today) throw badRequest('startDay cannot be in the past');
    if (deadline && deadline < ctx.today) throw badRequest('deadline cannot be in the past');

    const days = await listCapacity(from, addDays(from, PLANNING_HORIZON_DAYS));
    const plan = planProduction(requiredMinutes, days, from, deadline ?? null);
    const windowEnd = deadline ?? addDays(from, 13);
    return {
      ...plan,
      freeMinutesByDay: days
        .filter((d) => d.day <= windowEnd)
        .map((d) => ({ day: d.day, freeMinutes: d.freeMinutes })),
    };
  },
});
