/**
 * Who may move an order into which status. This is the human-in-the-loop guarantee:
 * AI agents can analyse and propose, but only a person can approve, reject, or fulfil an order.
 */
import { canTransition, type OrderStatus, type StatusActor } from '@sbom/shared';

const AUTOMATED_TARGETS: readonly OrderStatus[] = [
  'processing',
  'needs_info',
  'needs_review',
  'awaiting_approval',
];

const ALLOWED_TARGETS: Record<StatusActor, readonly OrderStatus[] | 'any'> = {
  agent: AUTOMATED_TARGETS,
  system: AUTOMATED_TARGETS,
  human: 'any',
};

export type TransitionCheck =
  { ok: true } | { ok: false; code: 'INVALID_TRANSITION' | 'FORBIDDEN'; reason: string };

export function checkTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: StatusActor,
): TransitionCheck {
  if (!canTransition(from, to)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      reason: `An order cannot move from '${from}' to '${to}'.`,
    };
  }
  const allowed = ALLOWED_TARGETS[actor];
  if (allowed !== 'any' && !allowed.includes(to)) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: `Only a person can move an order to '${to}'. The ${actor} may only set: ${allowed.join(', ')}.`,
    };
  }
  return { ok: true };
}

/** Statuses in which the order holds reserved stock and booked production time. */
export const HOLDS_RESOURCES: readonly OrderStatus[] = ['confirmed', 'in_production', 'ready'];
