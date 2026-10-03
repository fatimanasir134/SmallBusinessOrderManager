import type { ProductDto } from '@sbom/shared';
import { type Db, query, queryOne } from '../db/client.js';
import { suggestedReorder } from '../domain/inventory.js';

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: string;
  unit_price_cents: number;
  production_minutes_per_unit: number;
  made_to_order: boolean;
  active: boolean;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number;
  inventory_updated_at: string;
}

// Products always come back with their inventory row joined in.
const SELECT_PRODUCTS = `
  SELECT p.id, p.sku, p.name, p.description, p.category, p.unit_price_cents,
         p.production_minutes_per_unit, p.made_to_order, p.active,
         i.on_hand, i.reserved, i.available, i.reorder_point, i.updated_at AS inventory_updated_at
  FROM products p
  JOIN inventory i ON i.product_id = p.id`;

const toDto = (r: ProductRow): ProductDto => {
  const inventory = {
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.available,
    reorderPoint: r.reorder_point,
    lowStock: !r.made_to_order && r.available <= r.reorder_point,
    updatedAt: r.inventory_updated_at,
  };
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    category: r.category,
    unitPriceCents: r.unit_price_cents,
    productionMinutesPerUnit: r.production_minutes_per_unit,
    madeToOrder: r.made_to_order,
    active: r.active,
    inventory: {
      ...inventory,
      suggestedReorder: suggestedReorder({ madeToOrder: r.made_to_order, inventory }),
    },
  };
};

export async function listProducts({ activeOnly = false } = {}, db?: Db): Promise<ProductDto[]> {
  const rows = await query<ProductRow>(
    `${SELECT_PRODUCTS} ${activeOnly ? 'WHERE p.active' : ''} ORDER BY p.name`,
    [],
    db,
  );
  return rows.map(toDto);
}

export async function getProduct(id: number, db?: Db): Promise<ProductDto | undefined> {
  const row = await queryOne<ProductRow>(`${SELECT_PRODUCTS} WHERE p.id = $1`, [id], db);
  return row && toDto(row);
}

export async function getProductBySku(sku: string, db?: Db): Promise<ProductDto | undefined> {
  const row = await queryOne<ProductRow>(
    `${SELECT_PRODUCTS} WHERE upper(p.sku) = upper($1)`,
    [sku],
    db,
  );
  return row && toDto(row);
}

export async function updateProductPrice(
  id: number,
  unitPriceCents: number,
  db?: Db,
): Promise<boolean> {
  const rows = await query(
    'UPDATE products SET unit_price_cents = $2, updated_at = now() WHERE id = $1 RETURNING id',
    [id, unitPriceCents],
    db,
  );
  return rows.length > 0;
}
