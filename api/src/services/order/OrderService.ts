/**
 * @file OrderService.ts
 * Orchestrates order creation, status transitions, and proof-of-delivery capture.
 */

import { z } from 'zod';
import { DataSource } from 'typeorm';
import { Order } from '../../entities/Order.entity';
import { Payment } from '../../entities/Payment.entity';
import { GeoService } from '../geo/GeoService';
import { PricingEngine } from '../pricing/PricingEngine';
import { DispatchEngine } from '../dispatch/DispatchEngine';
import {
  CancellationReason,
  Currency,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  ProofType,
  VehicleType,
} from '../../types/enums';
import type {
  AddressDetails,
  GeoPoint,
  PackageDetails,
  ProofRecord,
} from '../../types/interfaces';
import { generateOrderNumber } from '../../utils/order-number.util';
import { NotFoundError, AppError } from '../../middleware/error.middleware';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Zod input schemas (validated by route middleware before reaching service)
// ─────────────────────────────────────────────────────────────────────────────

export const createOrderSchema = z.object({
  pickupAddress: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    district: z.string().optional(),
    city: z.string().min(1),
    countryCode: z.string().length(2),
    postalCode: z.string().optional(),
    placeId: z.string().optional(),
  }),
  pickupLocation: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([
      z.number().min(-180).max(180), // longitude
      z.number().min(-90).max(90),   // latitude
    ]),
  }),
  dropoffAddress: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    district: z.string().optional(),
    city: z.string().min(1),
    countryCode: z.string().length(2),
    postalCode: z.string().optional(),
    placeId: z.string().optional(),
  }),
  dropoffLocation: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }),
  type: z.nativeEnum(OrderType).default(OrderType.STANDARD),
  currency: z.nativeEnum(Currency),
  vehicleType: z.nativeEnum(VehicleType).default(VehicleType.MOTORCYCLE),
  paymentMethod: z.nativeEnum(PaymentMethod).default(PaymentMethod.CASH),
  requiresProofType: z.nativeEnum(ProofType).default(ProofType.PHOTO),
  recipientName: z.string().optional(),
  recipientPhoneE164: z.string().optional(),
  deliveryNotes: z.string().max(500).optional(),
  packageDetails: z
    .object({
      description: z.string().optional(),
      weightKg: z.number().positive().optional(),
      dimensions: z
        .object({ lengthCm: z.number(), widthCm: z.number(), heightCm: z.number() })
        .optional(),
      isFragile: z.boolean().optional(),
      requiresColdChain: z.boolean().optional(),
      declaredValue: z.number().optional(),
      declaredValueCurrency: z.nativeEnum(Currency).optional(),
    })
    .optional(),
  scheduledAt: z.coerce.date().optional(),
  promoCode: z.string().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export class OrderService {
  constructor(
    private readonly db: DataSource,
    private readonly geo: GeoService,
    private readonly pricing: PricingEngine,
    private readonly dispatch: DispatchEngine,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Create
  // ─────────────────────────────────────────────────────────────────────────

  async createOrder(customerId: string, input: CreateOrderInput): Promise<Order> {
    const pickupGeo = input.pickupLocation as GeoPoint;
    const dropoffGeo = input.dropoffLocation as GeoPoint;

    // Calculate route distance
    const distanceKm = await this.geo.distanceKm(pickupGeo, dropoffGeo);

    // Price the trip
    const fare = this.pricing.calculate({
      distanceKm,
      currency: input.currency,
      vehicleType: input.vehicleType,
      weightKg: input.packageDetails?.weightKg,
      promoCode: input.promoCode,
    });

    const order = this.db.getRepository(Order).create({
      orderNumber: generateOrderNumber(),
      customerId,
      type: input.type,
      status: OrderStatus.PENDING,
      pickupAddress: input.pickupAddress as AddressDetails,
      pickupLocation: GeoService.toWkt(pickupGeo),
      dropoffAddress: input.dropoffAddress as AddressDetails,
      dropoffLocation: GeoService.toWkt(dropoffGeo),
      packageDetails: input.packageDetails as PackageDetails | undefined,
      requiresProofType: input.requiresProofType,
      recipientName: input.recipientName,
      recipientPhoneE164: input.recipientPhoneE164,
      deliveryNotes: input.deliveryNotes,
      scheduledAt: input.scheduledAt,
      estimatedDistanceKm: distanceKm,
      currency: fare.currency,
      baseFare: fare.baseFare,
      distanceFare: fare.distanceFare,
      surcharge: fare.surcharge,
      discount: fare.discount,
      platformFee: fare.platformFee,
      totalFare: fare.totalFare,
      driverPayout: fare.driverPayout,
      exchangeRateToUsd: fare.exchangeRateToUsd,
      fareBreakdown: fare,
      paymentMethod: input.paymentMethod,
      paymentStatus: PaymentStatus.PENDING,
      dispatchAttempts: 0,
    });

    await this.db.getRepository(Order).save(order);

    // Create associated payment record
    const payment = this.db.getRepository(Payment).create({
      orderId: order.id,
      customerId,
      amount: fare.totalFare,
      currency: fare.currency,
      exchangeRateToUsd: fare.exchangeRateToUsd,
      platformFee: fare.platformFee,
      driverPayout: fare.driverPayout,
      method: input.paymentMethod,
      status: PaymentStatus.PENDING,
    });
    await this.db.getRepository(Payment).save(payment);

    logger.info({ orderId: order.id, customerId }, '[OrderService] Order created');

    // Fire-and-forget dispatch (unless scheduled for the future)
    if (!input.scheduledAt || input.scheduledAt <= new Date()) {
      void this.dispatch.dispatch(order.id);
    }

    return order;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status transitions (called by drivers via WebSocket or REST)
  // ─────────────────────────────────────────────────────────────────────────

  async markDriverEnRoute(orderId: string, driverId: string): Promise<Order> {
    return this.transition(orderId, driverId, OrderStatus.DRIVER_EN_ROUTE, {
      allowedCurrentStatuses: [OrderStatus.DRIVER_ASSIGNED],
    });
  }

  async markDriverArrived(orderId: string, driverId: string): Promise<Order> {
    return this.transition(orderId, driverId, OrderStatus.DRIVER_ARRIVED, {
      allowedCurrentStatuses: [OrderStatus.DRIVER_EN_ROUTE],
      extraUpdate: { driverArrivedAt: new Date() },
    });
  }

  async markPickedUp(orderId: string, driverId: string, proof?: ProofRecord): Promise<Order> {
    return this.transition(orderId, driverId, OrderStatus.PICKED_UP, {
      allowedCurrentStatuses: [OrderStatus.DRIVER_ARRIVED],
      extraUpdate: { pickedUpAt: new Date(), proofOfPickup: proof },
    });
  }

  async markInTransit(orderId: string, driverId: string): Promise<Order> {
    return this.transition(orderId, driverId, OrderStatus.IN_TRANSIT, {
      allowedCurrentStatuses: [OrderStatus.PICKED_UP],
    });
  }

  async markDelivered(orderId: string, driverId: string, proof: ProofRecord): Promise<Order> {
    const order = await this.transition(orderId, driverId, OrderStatus.DELIVERED, {
      allowedCurrentStatuses: [OrderStatus.IN_TRANSIT],
      extraUpdate: { deliveredAt: new Date(), proofOfDelivery: proof },
    });

    // Trigger payment capture
    await this.capturePayment(orderId);

    return order;
  }

  async cancelOrder(
    orderId: string,
    cancelledBy: string,
    reason: CancellationReason,
    notes?: string,
  ): Promise<Order> {
    const order = await this.findOrFail(orderId);

    if (order.isTerminal) {
      throw new AppError(409, `Order ${order.orderNumber} is already in a terminal state`);
    }

    await this.db.getRepository(Order).update(orderId, {
      status: OrderStatus.CANCELLED,
      cancellationReason: reason,
      cancellationNotes: notes,
      cancelledBy,
      cancelledAt: new Date(),
    });

    return this.findOrFail(orderId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────

  async getOrderById(orderId: string): Promise<Order> {
    return this.findOrFail(orderId);
  }

  async getCustomerOrders(
    customerId: string,
    page = 1,
    limit = 20,
  ): Promise<{ orders: Order[]; total: number }> {
    const [orders, total] = await this.db
      .getRepository(Order)
      .findAndCount({
        where: { customerId },
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });
    return { orders, total };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async transition(
    orderId: string,
    driverId: string,
    newStatus: OrderStatus,
    opts: {
      allowedCurrentStatuses: OrderStatus[];
      extraUpdate?: Partial<Order>;
    },
  ): Promise<Order> {
    const order = await this.findOrFail(orderId);

    if (order.driverId !== driverId) {
      throw new AppError(403, 'You are not assigned to this order');
    }

    if (!opts.allowedCurrentStatuses.includes(order.status)) {
      throw new AppError(
        409,
        `Cannot transition to ${newStatus} from ${order.status}`,
      );
    }

    await this.db.getRepository(Order).update(orderId, {
      status: newStatus,
      ...opts.extraUpdate,
    });

    return this.findOrFail(orderId);
  }

  private async findOrFail(orderId: string): Promise<Order> {
    const order = await this.db.getRepository(Order).findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundError('Order');
    return order;
  }

  private async capturePayment(orderId: string): Promise<void> {
    await this.db.getRepository(Payment).update(
      { orderId },
      { status: PaymentStatus.CAPTURED, capturedAt: new Date() },
    );
  }
}
