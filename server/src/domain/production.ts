/**
 * Production scheduling: fit the required studio minutes into free capacity, earliest day first.
 * Work can be split across days. Items that ship from stock need no production and are ready today.
 */
import { daysBetween } from './dates.js';

export interface CapacityDay {
  day: string;
  capacityMinutes: number;
  bookedMinutes: number;
}

export interface ScheduledSlot {
  day: string;
  minutes: number;
}

export interface ProductionPlan {
  requiredMinutes: number;
  /** Free minutes from startDay through the deadline (or the whole horizon if no deadline). */
  freeMinutesInWindow: number;
  schedule: ScheduledSlot[];
  /** Day the last minute of work is done; null if it doesn't fit in the known capacity. */
  completionDay: string | null;
  fitsInHorizon: boolean;
  /** null when there is no deadline. */
  meetsDeadline: boolean | null;
}

/**
 * @param days capacity rows (any order); days before startDay are ignored
 * @param deadline optional 'YYYY-MM-DD': work must be finished on or before this day
 */
export function planProduction(
  requiredMinutes: number,
  days: CapacityDay[],
  startDay: string,
  deadline: string | null = null,
): ProductionPlan {
  const usable = days.filter((d) => d.day >= startDay).sort((a, b) => a.day.localeCompare(b.day));

  const freeMinutesInWindow = usable
    .filter((d) => deadline === null || d.day <= deadline)
    .reduce((s, d) => s + Math.max(d.capacityMinutes - d.bookedMinutes, 0), 0);

  if (requiredMinutes <= 0) {
    return {
      requiredMinutes: 0,
      freeMinutesInWindow,
      schedule: [],
      completionDay: startDay,
      fitsInHorizon: true,
      meetsDeadline: deadline === null ? null : startDay <= deadline,
    };
  }

  const schedule: ScheduledSlot[] = [];
  let left = requiredMinutes;
  for (const d of usable) {
    const free = Math.max(d.capacityMinutes - d.bookedMinutes, 0);
    if (free === 0) continue;
    const minutes = Math.min(free, left);
    schedule.push({ day: d.day, minutes });
    left -= minutes;
    if (left === 0) break;
  }

  const fitsInHorizon = left === 0;
  const completionDay = fitsInHorizon ? schedule.at(-1)!.day : null;
  return {
    requiredMinutes,
    freeMinutesInWindow,
    schedule: fitsInHorizon ? schedule : [],
    completionDay,
    fitsInHorizon,
    meetsDeadline: deadline === null ? null : completionDay !== null && completionDay <= deadline,
  };
}

export interface CompletionEstimate {
  estimatedCompletionDate: string | null;
  requestedDeadline: string | null;
  meetsDeadline: boolean | null;
  /** Days between completion and deadline (positive = early). */
  slackDays: number | null;
  needsProduction: boolean;
  plan: ProductionPlan;
  summary: string;
}

/** Combine the stock assessment and the production plan into a single answer for the customer. */
export function estimateCompletion(
  productionMinutes: number,
  days: CapacityDay[],
  today: string,
  deadline: string | null,
): CompletionEstimate {
  const plan = planProduction(productionMinutes, days, today, deadline);
  const done = plan.completionDay;
  const slackDays = done && deadline ? daysBetween(done, deadline) : null;

  let summary: string;
  if (productionMinutes === 0) summary = 'Everything ships from stock and can be ready today.';
  else if (!done) {
    const lastDay = days
      .map((d) => d.day)
      .sort()
      .at(-1);
    summary =
      `Needs ${productionMinutes} minutes of production, which doesn't fit in the scheduled ` +
      `capacity${lastDay ? ` (through ${lastDay})` : ''}.`;
  } else {
    summary = `Needs ${productionMinutes} minutes of production; ready on ${done}.`;
  }
  if (deadline && done) {
    summary += plan.meetsDeadline
      ? ` That meets the ${deadline} deadline.`
      : ` That misses the ${deadline} deadline by ${-slackDays!} day(s).`;
  }

  return {
    estimatedCompletionDate: done,
    requestedDeadline: deadline,
    meetsDeadline: plan.meetsDeadline,
    slackDays,
    needsProduction: productionMinutes > 0,
    plan,
    summary,
  };
}
