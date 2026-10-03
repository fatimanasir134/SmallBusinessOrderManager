import type { CustomerTier, PricingRuleDto, PricingRuleType } from '@sbom/shared';
import { type Db, query } from '../db/client.js';

interface PricingRuleRow {
  id: number;
  name: string;
  description: string;
  rule_type: PricingRuleType;
  product_id: number | null;
  customer_tier: CustomerTier | null;
  min_quantity: number | null;
  max_days_until_deadline: number | null;
  percent: number;
  active: boolean;
}

const toDto = (r: PricingRuleRow): PricingRuleDto => ({
  id: r.id,
  name: r.name,
  description: r.description,
  ruleType: r.rule_type,
  productId: r.product_id,
  customerTier: r.customer_tier,
  minQuantity: r.min_quantity,
  maxDaysUntilDeadline: r.max_days_until_deadline,
  percent: r.percent,
  active: r.active,
});

export async function listPricingRules(
  { activeOnly = false } = {},
  db?: Db,
): Promise<PricingRuleDto[]> {
  const rows = await query<PricingRuleRow>(
    `SELECT * FROM pricing_rules ${activeOnly ? 'WHERE active' : ''}
     ORDER BY rule_type, product_id NULLS FIRST, min_quantity NULLS FIRST, id`,
    [],
    db,
  );
  return rows.map(toDto);
}
