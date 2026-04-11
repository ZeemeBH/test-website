/**
 * @file routes/index.ts
 * Mounts all route modules under the /api/v1 prefix.
 * Each router is a self-contained module with its own middleware chain.
 */

import { Router } from 'express';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createAuthController } from '../controllers/auth.controller';
import { createOrderController } from '../controllers/order.controller';
import { authenticate, requireRole } from '../middleware/auth.middleware';
import { OrderService } from '../services/order/OrderService';
import { GeoService } from '../services/geo/GeoService';
import { PricingEngine } from '../services/pricing/PricingEngine';
import type { DispatchEngine } from '../services/dispatch/DispatchEngine';

export function createRouter(db: DataSource, _redis: Redis, dispatch: DispatchEngine): Router {
  const router = Router();

  const geo = new GeoService(db);
  const pricing = new PricingEngine();
  const orderService = new OrderService(db, geo, pricing, dispatch);

  const authCtrl = createAuthController(db);
  const orderCtrl = createOrderController(orderService);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = Router();
  auth.post('/register', ...authCtrl.register);
  auth.post('/login', ...authCtrl.login);
  auth.post('/refresh', ...authCtrl.refresh);
  auth.post('/logout', authenticate, authCtrl.logout);
  auth.get('/me', authenticate, authCtrl.me);
  router.use('/auth', auth);

  // ── Orders ────────────────────────────────────────────────────────────────
  const orders = Router();
  orders.use(authenticate);
  orders.post('/', ...orderCtrl.create);
  orders.get('/mine', orderCtrl.listMine);
  orders.get('/:orderId', orderCtrl.getById);
  orders.post('/:orderId/cancel', ...orderCtrl.cancel);

  // Driver-only status transitions
  orders.post('/:orderId/en-route', requireRole('DRIVER'), orderCtrl.markEnRoute);
  orders.post('/:orderId/arrived', requireRole('DRIVER'), orderCtrl.markArrived);
  orders.post('/:orderId/picked-up', requireRole('DRIVER'), ...orderCtrl.markPickedUp);
  orders.post('/:orderId/in-transit', requireRole('DRIVER'), orderCtrl.markInTransit);
  orders.post('/:orderId/delivered', requireRole('DRIVER'), ...orderCtrl.markDelivered);
  router.use('/orders', orders);

  // ── Health ────────────────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}
