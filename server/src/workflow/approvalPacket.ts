/**
 * Builds the approval request a person reviews before anything is confirmed. Pure function over
 * the verified agent results: no AI and no database, so the warnings and recommendation are
 * deterministic and testable.
 */
import type {
  AgentName,
  ApprovalPacket,
  ApprovalWarning,
  Channel,
  CustomerDto,
  RecommendedAction,
  StopReason,
  Verification,
} from '@sbom/shared';
import type { InventoryOutput } from '../agents/inventory.js';
import type { PricingOutput } from '../agents/pricing.js';
import type { ProductionOutput } from '../agents/production.js';
import type { UnderstandingOutput } from '../agents/understanding.js';

export interface PacketInput {
  orderId: number;
  runId: string;
  stopReason: StopReason;
  message: string;
  channel: Channel;
  customer: CustomerDto | undefined;
  /** The customer record was created from this message (not known before). */
  customerIsNew: boolean;
  extraction: UnderstandingOutput | null;
  pricing: PricingOutput | null;
  inventory: InventoryOutput | null;
  production: ProductionOutput | null;
  draftReply: string | null;
  steps: {
    agent: AgentName;
    verification: Verification;
    discrepancies: string[];
    route?: string;
    routeReason?: string;
  }[];
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

const STOP_WARNINGS: Partial<Record<StopReason, ApprovalWarning>> = {
  missing_info: {
    code: 'missing_info',
    severity: 'critical',
    message:
      'The request is incomplete; the draft reply asks the customer for the missing details.',
  },
  unknown_product: {
    code: 'unknown_product',
    severity: 'critical',
    message: "The customer asked for something we don't sell.",
  },
  insufficient_inventory: {
    code: 'insufficient_inventory',
    severity: 'critical',
    message: "Some items are out of stock and can't be produced in the studio.",
  },
  deadline_impossible: {
    code: 'deadline_impossible',
    severity: 'critical',
    message: "The order can't be ready by the customer's deadline.",
  },
  unverified_reply: {
    code: 'unverified_reply',
    severity: 'critical',
    message:
      'The draft reply mentions amounts that are not in the verified quote. Edit it before sending.',
  },
};

export function buildApprovalPacket(input: PacketInput): ApprovalPacket {
  const { extraction: ex, pricing, inventory, production } = input;
  const warnings: ApprovalWarning[] = [];
  const add = (code: string, severity: ApprovalWarning['severity'], message: string) =>
    warnings.push({ code, severity, message });

  const stopWarning = STOP_WARNINGS[input.stopReason];
  if (stopWarning) warnings.push(stopWarning);

  // Where the backend had to overrule an agent.
  const overruled = input.steps.filter(
    (s) => s.verification === 'corrected' || s.verification === 'recomputed',
  );
  for (const s of overruled) {
    add(
      `agent_${s.verification}`,
      // The understanding agent's date being fixed by our parser is routine; numbers are not.
      s.agent === 'understanding' ? 'info' : 'warning',
      `${s.agent} agent: backend ${s.verification} its result` +
        (s.discrepancies.length ? ` (${s.discrepancies.join('; ')})` : '') +
        '. Verified tool values are shown.',
    );
  }

  if (!input.customer) {
    add(
      'unknown_customer',
      'warning',
      'No customer record or contact details: check who to reply to.',
    );
  } else if (input.customerIsNew) {
    add('new_customer', 'info', `New customer created from this message: ${input.customer.name}.`);
  }

  if (ex?.customization) {
    add(
      'customization',
      'warning',
      `Customization requested: "${ex.customization}". Confirm the design details before production.`,
    );
  }
  if (ex?.otherRequests) add('other_request', 'info', `Other request: "${ex.otherRequests}".`);
  if (ex && !ex.requestedDeadline && input.stopReason === 'human_approval_required') {
    add('no_deadline', 'info', 'No deadline given.');
  }

  if (pricing) {
    if (pricing.quote.surchargeCents > 0) {
      add(
        'rush_surcharge',
        'info',
        `Rush surcharge of ${money(pricing.quote.surchargeCents)} applied.`,
      );
    }
    if (pricing.discountDecision === 'not_eligible') {
      add(
        'discount_declined',
        'info',
        'Customer asked for a discount but no pricing rule applies.',
      );
    }
  }

  if (inventory) {
    for (const l of inventory.assessment.lines) {
      if (l.belowReorderPointAfter && l.unfulfillable === 0) {
        add('low_stock', 'info', `${l.sku} drops to ${l.availableAfter} available: reorder soon.`);
      }
    }
    if (inventory.assessment.totalToProduce > 0 && inventory.assessment.fulfillable) {
      add(
        'needs_production',
        'info',
        `${inventory.assessment.totalToProduce} unit(s) must be produced ` +
          `(${inventory.assessment.totalProductionMinutes} min).`,
      );
    }
  }

  if (production?.estimate.slackDays === 0 && production.feasible) {
    add('tight_deadline', 'warning', 'Ready on the deadline day itself: no room for delays.');
  }

  const { action, reason } = recommend(input, warnings);
  const e = production?.estimate;

  return {
    orderId: input.orderId,
    runId: input.runId,
    stopReason: input.stopReason,
    customer: {
      id: input.customer?.id ?? null,
      name: input.customer?.name ?? ex?.customer.name ?? null,
      tier: input.customer?.tier ?? null,
      channel: input.channel,
      email: input.customer?.email ?? ex?.customer.email ?? null,
      phone: input.customer?.phone ?? ex?.customer.phone ?? null,
      isNew: input.customerIsNew,
    },
    request: {
      message: input.message,
      items: (ex?.items ?? []).map((i) => ({
        productId: i.productId,
        sku: i.sku,
        name: i.productName,
        quantity: i.quantity,
      })),
      unresolved: (ex?.unresolvedItems ?? []).map((u) => ({
        asked: u.productQuery,
        reason: u.reason,
      })),
      requestedDeadline: ex?.requestedDeadline ?? null,
      customization: ex?.customization ?? null,
      otherRequests: ex?.otherRequests ?? null,
      discountRequested: ex?.discountRequested ?? false,
    },
    pricing: pricing && {
      subtotalCents: pricing.quote.subtotalCents,
      discountCents: pricing.quote.discountCents,
      surchargeCents: pricing.quote.surchargeCents,
      totalCents: pricing.quote.totalCents,
      discountPercent: pricing.quote.discountPercent,
      appliedRules: pricing.quote.appliedRules.map((r) => r.name),
      discountDecision: pricing.discountDecision,
      explanation: pricing.explanation,
    },
    inventory: inventory && {
      fulfillable: inventory.assessment.fulfillable,
      allInStock: inventory.assessment.allInStock,
      lines: inventory.assessment.lines.map((l) => ({
        sku: l.sku,
        requested: l.requested,
        fromStock: l.fromStock,
        toProduce: l.toProduce,
        unfulfillable: l.unfulfillable,
        availableAfter: l.availableAfter,
        belowReorderPointAfter: l.belowReorderPointAfter,
      })),
      summary: inventory.summary,
    },
    production: e
      ? {
          feasible: production!.feasible,
          needsProduction: e.needsProduction,
          estimatedCompletionDate: e.estimatedCompletionDate,
          requestedDeadline: e.requestedDeadline,
          meetsDeadline: e.meetsDeadline,
          slackDays: e.slackDays,
          earliestPossibleDate: e.earliestPossibleDate,
          summary: e.summary,
        }
      : null,
    response: { draftReply: input.draftReply },
    verification: overruled.map((s) => ({
      agent: s.agent,
      verification: s.verification,
      discrepancies: s.discrepancies,
    })),
    routing: input.steps
      .filter((s) => s.route)
      .map((s) => ({ agent: s.agent, route: s.route!, reason: s.routeReason ?? '' })),
    offers: offersFrom(input),
    warnings,
    recommendedAction: action,
    recommendationReason: reason,
  };
}

function recommend(
  input: PacketInput,
  warnings: ApprovalWarning[],
): { action: RecommendedAction; reason: string } {
  const e = input.production?.estimate;
  switch (input.stopReason) {
    case 'missing_info':
    case 'unknown_product':
      return {
        action: 'request_info',
        reason: 'Send the clarifying reply and wait for the customer before quoting.',
      };
    case 'insufficient_inventory':
      return input.inventory?.offer && input.inventory.offer !== 'none'
        ? {
            action: 'review',
            reason:
              `The order can't be fulfilled as asked; the reply offers a ${input.inventory.offer}. ` +
              'Send it and continue when the customer answers, or reject if they decline.',
          }
        : {
            action: 'reject',
            reason:
              "The order can't be fulfilled and there is nothing to offer. Reject it and send the explanation.",
          };
    case 'deadline_impossible':
      return {
        action: 'review',
        reason:
          `The deadline can't be met` +
          (e?.earliestPossibleDate ? `; earliest possible is ${e.earliestPossibleDate}` : '') +
          '. Send the proposed alternative and continue when the customer answers; approve directly ' +
          'only if they already accepted the later date.',
      };
    case 'unverified_reply':
      return {
        action: 'review',
        reason: 'Edit the reply so it only uses the verified quote, then approve.',
      };
    case 'agent_error':
      return { action: 'review', reason: 'The analysis did not finish. Retry it before deciding.' };
    case 'human_approval_required': {
      const serious = warnings.filter((w) => w.severity !== 'info');
      return serious.length
        ? {
            action: 'review',
            reason: `All checks passed, but review ${serious.length} warning(s) before approving.`,
          }
        : {
            action: 'approve',
            reason: 'Priced, in stock or schedulable, and on time. Safe to approve.',
          };
    }
  }
}

/** The alternatives the agents chose to put in front of the customer, in plain words. */
function offersFrom(input: PacketInput): string[] {
  const out: string[] = [];
  const up = input.pricing?.upsell;
  if (up) {
    out.push(
      `Upsell: add ${up.addUnits} × ${up.name} (${up.newQuantity} total) for ${up.newLineDiscountPercent}% off → ${money(up.newTotalCents)}.`,
    );
  }
  const inv = input.inventory;
  if (inv?.offer === 'substitute') {
    out.push(
      `Substitute: ${inv.substitutes.map((s) => `${s.name} (${money(s.unitPriceCents)})`).join(' or ')}.`,
    );
  } else if (inv?.offer === 'partial') {
    out.push(
      `Partial: ${inv.assessment.lines
        .filter((l) => l.requested - l.unfulfillable > 0)
        .map((l) => `${l.requested - l.unfulfillable} × ${l.sku}`)
        .join(', ')} can be supplied.`,
    );
  }
  const alt = input.production?.alternative;
  if (alt?.type === 'later_date') out.push(`Later date: full order by ${alt.readyBy}.`);
  if (alt?.type === 'reduced_quantity') {
    out.push(
      `Reduced quantity: ${alt.quantity} of ${alt.requested} × ${alt.sku} by ${alt.readyBy}.`,
    );
  }
  if (alt?.type === 'split_delivery') {
    out.push(
      `Split delivery: ${alt.now.map((n) => `${n.quantity} × ${n.sku}`).join(', ')} now, the rest by ${alt.restReadyBy}.`,
    );
  }
  return out;
}
