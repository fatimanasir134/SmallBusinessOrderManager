/**
 * Options to offer a customer when the straightforward answer is "no" (or "not quite"):
 *  - discountOpportunities  the next volume tier they could reach ("add 1 more for 5% off")
 *  - findSubstitutes        in-stock products in the same category for items we can't supply
 *  - deadlineAlternatives   earliest date, a quantity that does fit the deadline, or a split delivery
 * All pure functions over real prices, stock, and capacity, so agents choose between real options.
 */
import type { InventoryAssessment, LineAvailability } from './inventory.js';
import { calculatePrice, type PriceQuote, type PricingInput } from './pricing.js';

// ---------- Discounts ----------

export interface DiscountOpportunity {
  productId: number;
  currentQuantity: number;
  addUnits: number;
  newQuantity: number;
  ruleName: string;
  /** Discount on that line after adding the units. */
  newLineDiscountPercent: number;
  newTotalCents: number;
  /** What the extra units add to the order total (after the new discount). */
  extraCostCents: number;
}

/** Largest top-up we'd suggest, relative to what they ordered: keeps upsells reasonable. */
const MAX_UPSELL_FACTOR = 1;

export function discountOpportunities(
  input: PricingInput,
  quote: PriceQuote,
): DiscountOpportunity[] {
  const out: DiscountOpportunity[] = [];
  for (const line of quote.lines) {
    const tiers = input.rules
      .filter(
        (r) =>
          r.active &&
          r.ruleType === 'volume_discount' &&
          (r.productId === null || r.productId === line.productId) &&
          r.minQuantity !== null &&
          r.minQuantity > line.quantity,
      )
      .sort((a, b) => a.minQuantity! - b.minQuantity!);

    for (const tier of tiers) {
      const addUnits = tier.minQuantity! - line.quantity;
      if (addUnits > Math.max(2, line.quantity * MAX_UPSELL_FACTOR)) break;
      const bigger = calculatePrice({
        ...input,
        discountRequested: false,
        lines: input.lines.map((l) =>
          l.productId === line.productId ? { ...l, quantity: tier.minQuantity! } : l,
        ),
      });
      const newLine = bigger.lines.find((l) => l.productId === line.productId)!;
      if (newLine.discountPercent <= line.discountPercent) continue; // capped: no gain
      out.push({
        productId: line.productId,
        currentQuantity: line.quantity,
        addUnits,
        newQuantity: tier.minQuantity!,
        ruleName: tier.name,
        newLineDiscountPercent: newLine.discountPercent,
        newTotalCents: bigger.totalCents,
        extraCostCents: bigger.totalCents - quote.totalCents,
      });
      break; // only the nearest worthwhile tier per line
    }
  }
  return out;
}

// ---------- Substitutes ----------

export interface CatalogueItem {
  id: number;
  sku: string;
  name: string;
  category: string;
  unitPriceCents: number;
  active: boolean;
  madeToOrder: boolean;
  productionMinutesPerUnit: number;
  inventory: { available: number };
}

export interface Substitute {
  forProductId: number;
  productId: number;
  sku: string;
  name: string;
  unitPriceCents: number;
  available: number;
  /** Can cover the full requested quantity (from stock, or by producing it). */
  coversQuantity: boolean;
}

/** For each line we can't supply, up to two same-category products we can, closest in price first. */
export function findSubstitutes(
  lines: LineAvailability[],
  catalogue: CatalogueItem[],
): Substitute[] {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const out: Substitute[] = [];
  for (const line of lines.filter((l) => l.unfulfillable > 0)) {
    const original = byId.get(line.productId);
    if (!original) continue;
    catalogue
      .filter(
        (p) =>
          p.active &&
          p.id !== original.id &&
          p.category === original.category &&
          (p.madeToOrder ||
            p.productionMinutesPerUnit > 0 ||
            p.inventory.available >= line.requested),
      )
      .sort(
        (a, b) =>
          Math.abs(a.unitPriceCents - original.unitPriceCents) -
          Math.abs(b.unitPriceCents - original.unitPriceCents),
      )
      .slice(0, 2)
      .forEach((p) =>
        out.push({
          forProductId: original.id,
          productId: p.id,
          sku: p.sku,
          name: p.name,
          unitPriceCents: p.unitPriceCents,
          available: p.inventory.available,
          coversQuantity: true,
        }),
      );
  }
  return out;
}

// ---------- Deadlines ----------

export type DeadlineAlternative =
  | { type: 'later_date'; readyBy: string }
  | {
      type: 'reduced_quantity';
      productId: number;
      sku: string;
      quantity: number;
      requested: number;
      readyBy: string;
    }
  | {
      type: 'split_delivery';
      now: { productId: number; sku: string; quantity: number }[];
      readyNow: string;
      restReadyBy: string;
    };

/**
 * When the deadline can't be met: real options computed from stock and free capacity.
 * @param freeMinutesByDeadline free production minutes from today through the deadline
 */
export function deadlineAlternatives(args: {
  stock: InventoryAssessment;
  minutesPerUnit: Map<number, number>;
  freeMinutesByDeadline: number;
  earliestPossibleDate: string | null;
  today: string;
  deadline: string;
}): DeadlineAlternative[] {
  const out: DeadlineAlternative[] = [];
  if (args.earliestPossibleDate)
    out.push({ type: 'later_date', readyBy: args.earliestPossibleDate });

  // A smaller quantity that does fit: only when a single product needs making.
  const produced = args.stock.lines.filter((l) => l.productionMinutes > 0);
  if (produced.length === 1) {
    const line = produced[0]!;
    const perUnit = args.minutesPerUnit.get(line.productId) ?? 0;
    if (perUnit > 0) {
      const quantity = line.fromStock + Math.floor(args.freeMinutesByDeadline / perUnit);
      if (quantity > 0 && quantity < line.requested) {
        out.push({
          type: 'reduced_quantity',
          productId: line.productId,
          sku: line.sku,
          quantity,
          requested: line.requested,
          readyBy: args.deadline,
        });
      }
    }
  }

  // Ship what's in stock now, the rest when it's made.
  const inStock = args.stock.lines.filter((l) => l.fromStock > 0);
  if (inStock.length && args.stock.totalProductionMinutes > 0 && args.earliestPossibleDate) {
    out.push({
      type: 'split_delivery',
      now: inStock.map((l) => ({ productId: l.productId, sku: l.sku, quantity: l.fromStock })),
      readyNow: args.today,
      restReadyBy: args.earliestPossibleDate,
    });
  }
  return out;
}
