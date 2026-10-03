/**
 * Fail fast when two human actions hit the same order at once (double click, two reviewers).
 * The database already guarantees correctness (row locks, conditional updates, one decision per
 * approval request); this just stops the second request before it spends Gemini calls.
 * In-process only, which is enough for a single API server.
 */
import { conflict } from './errors.js';

const busy = new Set<number>();

export async function withOrderLock<T>(orderId: number, fn: () => Promise<T>): Promise<T> {
  if (busy.has(orderId)) {
    throw conflict(`Order ${orderId} is already being updated. Refresh and try again.`);
  }
  busy.add(orderId);
  try {
    return await fn();
  } finally {
    busy.delete(orderId);
  }
}
