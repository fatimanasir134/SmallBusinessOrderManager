/**
 * Turn the model's raw reading of a customer message into a validated order request.
 * Gemini reads the message; this code decides what is actually orderable:
 * product references must match the catalogue, quantities must be sane, and dates must be real
 * and in the future. Anything that fails becomes a "missing info" question for the customer.
 */
import type {
  ExtractedItemDto,
  OrderExtractionDto,
  RawExtractionDto,
  UnresolvedItemDto,
} from '@sbom/shared';
import { isValidIsoDay, resolveRelativeDate } from './dates.js';
import { type MatchableProduct, matchProduct } from './productMatching.js';

export const MAX_QUANTITY_PER_LINE = 1000;

// The extraction types are shared with the web app (see @sbom/shared).
export type RawExtraction = RawExtractionDto;
export type ResolvedItem = ExtractedItemDto;
export type UnresolvedItem = UnresolvedItemDto;
export type OrderExtraction = OrderExtractionDto;

export function normalizeExtraction(
  raw: RawExtraction,
  catalogue: MatchableProduct[],
  today: string,
): OrderExtraction {
  const items: ResolvedItem[] = [];
  const unresolvedItems: UnresolvedItem[] = [];
  const missingInfo: string[] = [];
  const toCandidates = (cs: { product: MatchableProduct }[]) =>
    cs
      .slice(0, 4)
      .map((c) => ({ productId: c.product.id, sku: c.product.sku, name: c.product.name }));

  for (const item of raw.items) {
    const query = item.productQuery.trim();
    if (!query) continue;
    const match = matchProduct(query, catalogue);

    if (match.kind !== 'matched') {
      const ambiguous = match.kind === 'ambiguous';
      unresolvedItems.push({
        productQuery: query,
        quantity: item.quantity,
        reason: ambiguous ? 'ambiguous_product' : 'unknown_product',
        candidates: toCandidates(match.candidates),
      });
      missingInfo.push(
        ambiguous
          ? `Which product did they mean by "${query}"? Options: ${toCandidates(match.candidates)
              .map((c) => c.name)
              .join(', ')}.`
          : `"${query}" doesn't match any product we sell.`,
      );
      continue;
    }

    const q = item.quantity;
    if (q === null) {
      unresolvedItems.push({
        productQuery: query,
        quantity: null,
        reason: 'missing_quantity',
        candidates: [],
      });
      missingInfo.push(`How many ${match.product.name} do they want?`);
      continue;
    }
    if (!Number.isInteger(q) || q <= 0 || q > MAX_QUANTITY_PER_LINE) {
      unresolvedItems.push({
        productQuery: query,
        quantity: q,
        reason: 'invalid_quantity',
        candidates: [],
      });
      missingInfo.push(
        `The quantity ${q} for ${match.product.name} isn't valid (1-${MAX_QUANTITY_PER_LINE}).`,
      );
      continue;
    }

    const existing = items.find((i) => i.productId === match.product.id);
    if (existing) {
      existing.quantity += q; // "2 pink sheets ... and 1 more pink sheet"
    } else {
      items.push({
        productId: match.product.id,
        sku: match.product.sku,
        productName: match.product.name,
        quantity: q,
        matchedFrom: query,
        matchScore: Math.round(match.score * 100) / 100,
      });
    }
  }

  if (raw.items.length === 0) missingInfo.push('Which products and how many do they want?');

  // Deadline: prefer our deterministic parser, fall back to the model's date.
  let requestedDeadline: string | null = null;
  let deadlineSource: OrderExtraction['deadlineSource'] = null;
  const parsed = raw.deadlineText ? resolveRelativeDate(raw.deadlineText, today) : null;
  if (parsed) {
    requestedDeadline = parsed;
    deadlineSource = 'parsed';
  } else if (raw.deadlineDate && isValidIsoDay(raw.deadlineDate)) {
    requestedDeadline = raw.deadlineDate;
    deadlineSource = 'model';
  }
  // A deadline we can't pin down ("no rush", "for the party") is not critical: quote without one.
  if (requestedDeadline && requestedDeadline < today) {
    missingInfo.push(
      `The deadline ${requestedDeadline} is in the past. Which day do they need it?`,
    );
    requestedDeadline = null;
    deadlineSource = null;
  }

  return {
    customer: raw.customer,
    items,
    unresolvedItems,
    requestedDeadline,
    deadlineSource,
    deadlineText: raw.deadlineText,
    discountRequested: raw.discountRequested,
    customization: raw.customization,
    otherRequests: raw.otherRequests,
    missingInfo,
    isComplete: items.length > 0 && unresolvedItems.length === 0,
  };
}
