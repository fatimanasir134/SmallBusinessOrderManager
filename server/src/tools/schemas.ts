/** Input building blocks shared by several tools. */
import { z } from 'zod';
import { isValidIsoDay } from '../domain/dates.js';
import { MAX_QUANTITY_PER_LINE } from '../domain/extraction.js';

export const id = z.number().int().positive();

export const isoDay = z
  .string()
  .refine(isValidIsoDay, 'must be a real calendar date in YYYY-MM-DD format');

export const orderLine = z.object({
  productId: id.describe('Product id from getProductInformation or extractOrderInformation'),
  quantity: z
    .number()
    .int()
    .positive()
    .max(MAX_QUANTITY_PER_LINE)
    .describe(`Number of units (1-${MAX_QUANTITY_PER_LINE})`),
});

export const orderLines = z
  .array(orderLine)
  .min(1, 'at least one item is required')
  .max(20, 'at most 20 different items per order');

export type OrderLineInput = z.infer<typeof orderLine>;

/** Merge duplicate product lines ("2 pink" + "1 pink" = 3 pink). */
export function mergeLines(lines: OrderLineInput[]): OrderLineInput[] {
  const merged = new Map<number, number>();
  for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.quantity);
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}
