import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { getCustomer, listCustomers } from '../repositories/customers.js';

export const customersRouter = Router();

customersRouter.get('/', async (_req, res) => {
  res.json(await listCustomers());
});

customersRouter.get('/:id', async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const customer = await getCustomer(id);
  if (!customer) throw notFound(`Customer ${id} not found`);
  res.json(customer);
});
