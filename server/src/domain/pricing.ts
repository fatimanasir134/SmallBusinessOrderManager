/**
 * Pricing engine. Pure function over the catalogue prices and pricing rules, so totals are
 * always computed by code, never by the model.
 *
 * Per line:  discount = best volume discount for that line (product-specific or global)
 *                       + customer tier discount, capped by the max_discount rule.
 * Per order: rush surcharge on the discounted subtotal when the deadline is close.
 * Money is integer cents; each line's discount is rounded to the nearest cent.
 */
import type { CustomerTier, PricingRuleDto } from '@sbom/shared';
import { daysBetween } from './dates.js';

export interface PriceLineInput {
  productId: number;
  quantity: number;
  unitPriceCents: number;
}

export interface PricingInput {
  lines: PriceLineInput[];
  rules: PricingRuleDto[];
  customerTier: CustomerTier | null;
  requestedDeadline: string | null;
  today: string;
  discountRequested?: boolean;
}

export interface AppliedRule {
  ruleId: number;
  name: string;
  ruleType: PricingRuleDto['ruleType'];
  percent: number;
  productId: number | null;
}

export interface PricedLine extends PriceLineInput {
  subtotalCents: number;
  discountPercent: number;
  discountCents: number;
  totalCents: number;
  appliedRules: AppliedRule[];
  capped: boolean;
}

export interface PriceQuote {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  /** Effective discount across the order, for display and the orders table. */
  discountPercent: number;
  surchargePercent: number;
  surchargeCents: number;
  totalCents: number;
  appliedRules: AppliedRule[];
  maxDiscountPercent: number | null;
  /** Plain-language notes the response agent can use (e.g. why a requested discount wasn't given). */
  notes: string[];
}

const applied = (r: PricingRuleDto): AppliedRule => ({
  ruleId: r.id,
  name: r.name,
  ruleType: r.ruleType,
  percent: r.percent,
  productId: r.productId,
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calculatePrice(input: PricingInput): PriceQuote {
  const rules = input.rules.filter((r) => r.active);
  const cap = rules.filter((r) => r.ruleType === 'max_discount').map((r) => r.percent);
  const maxDiscount = cap.length ? Math.min(...cap) : null;

  const tierRule = input.customerTier
    ? rules
        .filter(
          (r) => r.ruleType === 'customer_tier_discount' && r.customerTier === input.customerTier,
        )
        .sort((a, b) => b.percent - a.percent)[0]
    : undefined;

  const lines: PricedLine[] = input.lines.map((line) => {
    const subtotal = line.quantity * line.unitPriceCents;
    const volumeRule = rules
      .filter(
        (r) =>
          r.ruleType === 'volume_discount' &&
          (r.productId === null || r.productId === line.productId) &&
          r.minQuantity !== null &&
          line.quantity >= r.minQuantity,
      )
      .sort((a, b) => b.percent - a.percent)[0];

    const lineRules = [volumeRule, tierRule].filter((r): r is PricingRuleDto => Boolean(r));
    const uncapped = lineRules.reduce((sum, r) => sum + r.percent, 0);
    const percent = maxDiscount === null ? uncapped : Math.min(uncapped, maxDiscount);
    const discountCents = Math.round((subtotal * percent) / 100);
    return {
      ...line,
      subtotalCents: subtotal,
      discountPercent: percent,
      discountCents,
      totalCents: subtotal - discountCents,
      appliedRules: lineRules.map(applied),
      capped: percent < uncapped,
    };
  });

  const subtotalCents = lines.reduce((s, l) => s + l.subtotalCents, 0);
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  const afterDiscount = subtotalCents - discountCents;

  const appliedRules = new Map<number, AppliedRule>();
  for (const l of lines) for (const r of l.appliedRules) appliedRules.set(r.ruleId, r);

  let surchargePercent = 0;
  const notes: string[] = [];
  if (input.requestedDeadline) {
    const daysLeft = daysBetween(input.today, input.requestedDeadline);
    const rush = rules
      .filter(
        (r) =>
          r.ruleType === 'rush_surcharge' &&
          r.maxDaysUntilDeadline !== null &&
          daysLeft <= r.maxDaysUntilDeadline,
      )
      .sort((a, b) => b.percent - a.percent)[0];
    if (rush) {
      surchargePercent = rush.percent;
      appliedRules.set(rush.id, applied(rush));
      notes.push(
        `Rush surcharge of ${rush.percent}% applies: the deadline is ${daysLeft} day(s) away.`,
      );
    }
  }
  const surchargeCents = Math.round((afterDiscount * surchargePercent) / 100);

  if (lines.some((l) => l.capped) && maxDiscount !== null) {
    notes.push(`Discounts were capped at the ${maxDiscount}% maximum.`);
  }
  if (input.discountRequested) {
    if (discountCents > 0) {
      notes.push('The customer asked for a discount; the eligible discounts above were applied.');
    } else {
      const entry = rules
        .filter((r) => r.ruleType === 'volume_discount' && r.productId === null && r.minQuantity)
        .sort((a, b) => a.minQuantity! - b.minQuantity!)[0];
      notes.push(
        'The customer asked for a discount, but no pricing rule applies to this order.' +
          (entry
            ? ` ${entry.percent}% off starts at ${entry.minQuantity} units of a product.`
            : ''),
      );
    }
  }

  return {
    lines,
    subtotalCents,
    discountCents,
    discountPercent: subtotalCents ? round2((discountCents / subtotalCents) * 100) : 0,
    surchargePercent,
    surchargeCents,
    totalCents: afterDiscount + surchargeCents,
    appliedRules: [...appliedRules.values()],
    maxDiscountPercent: maxDiscount,
    notes,
  };
}
