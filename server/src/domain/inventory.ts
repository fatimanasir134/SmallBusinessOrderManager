/**
 * Decide, per order line, how much can ship from stock and how much must be produced.
 */

export interface StockProduct {
  id: number;
  sku: string;
  name: string;
  madeToOrder: boolean;
  productionMinutesPerUnit: number;
  inventory: { onHand: number; reserved: number; available: number; reorderPoint: number };
}

export type StockStatus = 'in_stock' | 'partial' | 'out_of_stock' | 'made_to_order';

/**
 * A product can be produced in the studio if it is made to order or has a production time.
 * Bought-in items (production time 0) can only ship from stock.
 */
export const canProduce = (p: Pick<StockProduct, 'madeToOrder' | 'productionMinutesPerUnit'>) =>
  p.madeToOrder || p.productionMinutesPerUnit > 0;

export interface LineAvailability {
  productId: number;
  sku: string;
  name: string;
  requested: number;
  available: number;
  fromStock: number;
  toProduce: number;
  productionMinutes: number;
  status: StockStatus;
  /** False for bought-in items: any shortfall can't be produced. */
  producible: boolean;
  /** Units that can neither ship from stock nor be produced. */
  unfulfillable: number;
  /** Stock left after this order would reserve its share. */
  availableAfter: number;
  belowReorderPointAfter: boolean;
}

export interface InventoryAssessment {
  lines: LineAvailability[];
  allInStock: boolean;
  /** Every unit can be supplied from stock or production. */
  fulfillable: boolean;
  totalToProduce: number;
  totalProductionMinutes: number;
}

export function assessInventory(
  items: { productId: number; quantity: number }[],
  products: StockProduct[],
): InventoryAssessment {
  const byId = new Map(products.map((p) => [p.id, p]));
  // Two lines for the same product share its stock.
  const remaining = new Map(products.map((p) => [p.id, Math.max(p.inventory.available, 0)]));

  const lines = items.map((item): LineAvailability => {
    const p = byId.get(item.productId);
    if (!p) throw new Error(`Product ${item.productId} was not loaded`);
    const available = p.madeToOrder ? 0 : remaining.get(p.id)!;
    const fromStock = Math.min(available, item.quantity);
    const toProduce = item.quantity - fromStock;
    remaining.set(p.id, available - fromStock);

    let status: StockStatus;
    if (p.madeToOrder) status = 'made_to_order';
    else if (toProduce === 0) status = 'in_stock';
    else if (fromStock > 0) status = 'partial';
    else status = 'out_of_stock';

    const availableAfter = available - fromStock;
    const producible = canProduce(p);
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      requested: item.quantity,
      available,
      fromStock,
      toProduce,
      productionMinutes: toProduce * p.productionMinutesPerUnit,
      status,
      producible,
      unfulfillable: producible ? 0 : toProduce,
      availableAfter,
      belowReorderPointAfter: !p.madeToOrder && availableAfter <= p.inventory.reorderPoint,
    };
  });

  return {
    lines,
    allInStock: lines.every((l) => l.toProduce === 0),
    fulfillable: lines.every((l) => l.unfulfillable === 0),
    totalToProduce: lines.reduce((s, l) => s + l.toProduce, 0),
    totalProductionMinutes: lines.reduce((s, l) => s + l.productionMinutes, 0),
  };
}

/**
 * How many units to reorder for a low-stock item: enough to bring available stock up to twice the
 * reorder point. null when nothing is needed (not low, made to order, or no reorder point).
 */
export function suggestedReorder(p: {
  madeToOrder: boolean;
  inventory: { available: number; reorderPoint: number };
}): number | null {
  const { available, reorderPoint } = p.inventory;
  if (p.madeToOrder || reorderPoint <= 0 || available > reorderPoint) return null;
  return Math.max(reorderPoint * 2 - available, 1);
}
