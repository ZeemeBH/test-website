/**
 * @file order.controller.ts
 * REST endpoints for order lifecycle management.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { OrderService } from '../services/order/OrderService';
import { createOrderSchema } from '../services/order/OrderService';
import { CancellationReason, ProofType } from '../types/enums';
import { validate } from '../middleware/validate.middleware';
import { AppError } from '../middleware/error.middleware';
import type { ProofRecord } from '../types/interfaces';

const cancelOrderSchema = z.object({
  reason: z.nativeEnum(CancellationReason),
  notes: z.string().max(500).optional(),
});

const proofSchema = z.object({
  type: z.nativeEnum(ProofType),
  signatureBase64: z.string().optional(),
  photoUrls: z.array(z.string().url()).optional(),
  recipientName: z.string().optional(),
  location: z
    .object({
      type: z.literal('Point'),
      coordinates: z.tuple([z.number(), z.number()]),
    })
    .optional(),
});

export function createOrderController(orderService: OrderService) {

  async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await orderService.createOrder(req.user!.id, req.body);
      res.status(201).json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await orderService.getOrderById(req.params.orderId);
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  async function listMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const { orders, total } = await orderService.getCustomerOrders(req.user!.id, page, limit);
      res.json({
        success: true,
        data: orders,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) { next(err); }
  }

  async function cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as z.infer<typeof cancelOrderSchema>;
      const order = await orderService.cancelOrder(
        req.params.orderId,
        req.user!.id,
        body.reason,
        body.notes,
      );
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  // ── Driver status transition endpoints ───────────────────────────────────

  async function markEnRoute(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await orderService.markDriverEnRoute(req.params.orderId, req.user!.id);
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  async function markArrived(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await orderService.markDriverArrived(req.params.orderId, req.user!.id);
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  async function markPickedUp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const proof = req.body as ProofRecord | undefined;
      const order = await orderService.markPickedUp(req.params.orderId, req.user!.id, proof);
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  async function markInTransit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await orderService.markInTransit(req.params.orderId, req.user!.id);
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  async function markDelivered(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.body || !req.body.type) {
        throw new AppError(400, 'Proof of delivery is required');
      }
      const proof = req.body as ProofRecord;
      proof.capturedAt = new Date().toISOString();
      const order = await orderService.markDelivered(req.params.orderId, req.user!.id, proof);
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  return {
    create: [validate(createOrderSchema), create],
    getById,
    listMine,
    cancel: [validate(cancelOrderSchema), cancel],
    markEnRoute,
    markArrived,
    markPickedUp: [validate(proofSchema.optional()), markPickedUp],
    markInTransit,
    markDelivered: [validate(proofSchema), markDelivered],
  };
}
