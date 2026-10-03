import { Router } from 'express';
import { listPricingRules } from '../repositories/pricingRules.js';

export const pricingRulesRouter = Router();

pricingRulesRouter.get('/', async (_req, res) => {
  res.json(await listPricingRules());
});
