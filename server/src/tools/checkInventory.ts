import { z } from 'zod';
import { findSubstitutes } from '../domain/alternatives.js';
import { assessInventory } from '../domain/inventory.js';
import { listProducts } from '../repositories/products.js';
import { loadOrderProducts } from './catalog.js';
import { mergeLines, orderLines } from './schemas.js';
import { defineTool } from './types.js';

const input = z.object({ items: orderLines });

export const checkInventory = defineTool({
  name: 'checkInventory',
  description:
    'Check stock for the requested items. For each line returns how many units can ship from ' +
    'available stock (fromStock), how many must be produced (toProduce), the production minutes ' +
    'needed, and whether stock falls below its reorder point. When items cannot be supplied, ' +
    'also returns in-stock substitutes from the same category. Does not reserve anything.',
  access: 'read',
  input,
  handler: async ({ items }) => {
    const lines = mergeLines(items);
    const products = await loadOrderProducts(lines.map((l) => l.productId));
    const assessment = assessInventory(lines, products);
    // For items we can't supply at all: same-category products we can.
    const substitutes = assessment.fulfillable
      ? []
      : findSubstitutes(assessment.lines, await listProducts({ activeOnly: true }));
    return { ...assessment, substitutes };
  },
});
