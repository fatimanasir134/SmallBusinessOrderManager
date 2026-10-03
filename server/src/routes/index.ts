import { Router } from 'express';
import { aiRouter } from './ai.js';
import { approvalsRouter } from './approvals.js';
import { capacityRouter } from './capacity.js';
import { customersRouter } from './customers.js';
import { healthRouter } from './health.js';
import { messagesRouter } from './messages.js';
import { ordersRouter } from './orders.js';
import { pricingRulesRouter } from './pricingRules.js';
import { productsRouter } from './products.js';
import { toolsRouter } from './tools.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/pricing-rules', pricingRulesRouter);
apiRouter.use('/capacity', capacityRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/approvals', approvalsRouter);
apiRouter.use('/tools', toolsRouter);
