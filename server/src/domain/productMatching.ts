/**
 * Match free-text product references ("pink sticker sheets", "holo stickers", "STK-PINK")
 * to catalogue products. Deterministic, so the AI can't invent a product that doesn't exist.
 */

export interface MatchableProduct {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: string;
  active: boolean;
}

export interface ProductMatch<P extends MatchableProduct = MatchableProduct> {
  product: P;
  /** 0..1: share of the query's words found in the product. */
  score: number;
}

export type MatchOutcome<P extends MatchableProduct = MatchableProduct> =
  | { kind: 'matched'; product: P; score: number }
  | { kind: 'ambiguous'; candidates: ProductMatch<P>[] }
  | { kind: 'none'; candidates: ProductMatch<P>[] };

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'and',
  'with',
  'some',
  'my',
  'your',
  'pack',
  'packs',
  'set',
  'sets',
  'x',
  'pcs',
  'piece',
  'pieces',
  'please',
  'pls',
]);

/** Lowercase, split on non-letters, drop filler words, and singularise simple plurals. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(singular);
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** A query word matches a product word exactly, or as a prefix of 3+ letters ("holo" -> "holographic"). */
function wordMatches(q: string, words: Set<string>): boolean {
  if (words.has(q)) return true;
  if (q.length < 3) return false;
  for (const w of words) if (w.startsWith(q) || (w.length >= 3 && q.startsWith(w))) return true;
  return false;
}

export function scoreProduct(query: string, product: MatchableProduct): number {
  const q = query.trim();
  if (q.toUpperCase() === product.sku.toUpperCase()) return 1;
  const qTokens = tokenize(q);
  if (qTokens.length === 0) return 0;
  // Name words count fully; description/category words count half.
  const nameWords = new Set(tokenize(`${product.name} ${product.sku}`));
  const otherWords = new Set(tokenize(`${product.description} ${product.category}`));
  let points = 0;
  for (const t of qTokens) {
    if (wordMatches(t, nameWords)) points += 1;
    else if (wordMatches(t, otherWords)) points += 0.5;
  }
  return points / qTokens.length;
}

export const MATCH_THRESHOLD = 0.6;
/** The best match must beat the runner-up by this much to be unambiguous. */
const CLEAR_LEAD = 0.15;

export function matchProduct<P extends MatchableProduct>(
  query: string,
  catalogue: P[],
): MatchOutcome<P> {
  const ranked = catalogue
    .filter((p) => p.active)
    .map((product) => ({ product, score: scoreProduct(query, product) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = ranked.slice(0, 5);
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return { kind: 'none', candidates: top };
  const second = ranked[1];
  if (second && best.score - second.score < CLEAR_LEAD) {
    return {
      kind: 'ambiguous',
      candidates: ranked.filter((m) => best.score - m.score < CLEAR_LEAD),
    };
  }
  return { kind: 'matched', product: best.product, score: best.score };
}
