/** Loading helpers shared by the tools: fetch exactly the products an order refers to. */
import type { ProductDto } from '@sbom/shared';
import type { Db } from '../db/client.js';
import { badRequest } from '../lib/errors.js';
import { listProducts } from '../repositories/products.js';

/** Load the given products; unknown or inactive ids are a validation error. */
export async function loadOrderProducts(productIds: number[], db?: Db): Promise<ProductDto[]> {
  const all = await listProducts({}, db);
  const byId = new Map(all.map((p) => [p.id, p]));
  const unknown = productIds.filter((pid) => !byId.has(pid));
  if (unknown.length) {
    throw badRequest(`Unknown product id(s): ${unknown.join(', ')}`, {
      unknownProductIds: unknown,
    });
  }
  const inactive = productIds.filter((pid) => !byId.get(pid)!.active);
  if (inactive.length) {
    throw badRequest(`Product(s) no longer sold: ${inactive.join(', ')}`, {
      inactiveProductIds: inactive,
    });
  }
  return productIds.map((pid) => byId.get(pid)!);
}
