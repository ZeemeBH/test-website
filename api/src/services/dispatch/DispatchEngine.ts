/**
 * @file DispatchEngine.ts
 * Core order-dispatch algorithm.
 *
 * ── Algorithm ─────────────────────────────────────────────────────────────
 *
 * 1. ACQUIRE DISPATCH LOCK (Redis SET NX EX)
 *    Prevents two concurrent processes from dispatching the same order
 *    (important in a multi-replica deployment).
 *
 * 2. QUERY NEARBY DRIVERS
 *    Fast pre-filter via Redis GEOSEARCH, then authoritative PostGIS
 *    ST_DWithin query for exact distance + liveness check.
 *
 * 3. SEQUENTIAL OFFER with TIMEOUT
 *    Drivers are offered the order one-by-one (closest first).
 *    Each driver gets DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS to accept/reject.
 *    An offer key is written to Redis with that TTL — if the key expires
 *    before a response, the offer is considered rejected.
 *
 * 4. RETRY LOOP
 *    If all drivers in the first radius reject, the radius is expanded by
 *    DISPATCH_RADIUS_KM per retry, up to DISPATCH_MAX_RETRIES attempts.
 *
 * 5. ASSIGNMENT
 *    On acceptance, the order row is updated (driverId, status, timestamp)
 *    inside a DB transaction and the dispatch lock is released.
 *
 * 6. NO DRIVER FOUND
 *    After all retries, the order is marked CANCELLED with reason
 *    NO_DRIVER_FOUND and the customer is notified via WebSocket.
 */

import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { RedisKey } from '../../config/redis';
import { GeoService } from '../geo/GeoService';
import { LocationTracker } from '../location/LocationTracker';
import { Order } from '../../entities/Order.entity';
import {
  CancellationReason,
  OrderStatus,
  SocketEvent,
  VehicleType,
} from '../../types/enums';
import type { DispatchAttempt, GeoPoint, NearbyDriver } from '../../types/interfaces';
import { logger } from '../../utils/logger';
import { getEnv } from '../../config/environment';
import type { SocketManager } from '../../socket/SocketManager';

export class DispatchEngine {
  constructor(
    private readonly db: DataSource,
    private readonly redis: Redis,
    private readonly geo: GeoService,
    private readonly locationTracker: LocationTracker,
    private readonly socketManager: SocketManager,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public entry point
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Starts the dispatch loop for a newly created order.
   * This method is intentionally fire-and-forget (no await needed at call site).
   */
  async dispatch(orderId: string): Promise<void> {
    const env = getEnv();

    // ── 1. Acquire lock ──────────────────────────────────────────────────
    const lockKey = RedisKey.dispatchLock(orderId);
    const lockTtl =
      (env.DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS * env.DISPATCH_MAX_RETRIES) / 1000 + 60;
    const acquired = await this.redis.set(lockKey, '1', 'EX', lockTtl, 'NX');

    if (!acquired) {
      logger.warn({ orderId }, '[Dispatch] Lock already held — skipping duplicate dispatch');
      return;
    }

    try {
      await this.runDispatchLoop(orderId);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private dispatch loop
  // ─────────────────────────────────────────────────────────────────────────

  private async runDispatchLoop(orderId: string): Promise<void> {
    const env = getEnv();
    const order = await this.loadOrder(orderId);
    if (!order) return;

    // Parse pickup location from WKT stored in DB
    const pickupGeo = await this.resolvePickupGeo(order);

    // Update order status to SEARCHING_DRIVER
    await this.updateOrderStatus(orderId, OrderStatus.SEARCHING_DRIVER);
    this.socketManager.notifyOrderStatusChange(orderId, OrderStatus.SEARCHING_DRIVER);

    let attempt = 0;
    let currentRadius = env.DISPATCH_RADIUS_KM;

    while (attempt < env.DISPATCH_MAX_RETRIES) {
      attempt++;
      logger.info({ orderId, attempt, radiusKm: currentRadius }, '[Dispatch] Attempting dispatch');

      // ── 2. Find nearby available drivers ──────────────────────────────
      const candidates = await this.geo.findNearbyDrivers(
        pickupGeo,
        currentRadius,
        order.packageDetails?.requiresColdChain ? VehicleType.REFRIGERATED : undefined,
      );

      if (candidates.length === 0) {
        logger.info({ orderId, attempt }, '[Dispatch] No drivers in radius — expanding');
        currentRadius += env.DISPATCH_RADIUS_KM;
        continue;
      }

      // ── 3. Offer to each driver sequentially ──────────────────────────
      const accepted = await this.offerToDrivers(order, candidates, attempt);

      if (accepted) {
        logger.info({ orderId, driverId: accepted }, '[Dispatch] Driver accepted order');
        await this.assignDriver(orderId, accepted);
        return;
      }

      currentRadius += env.DISPATCH_RADIUS_KM;
    }

    // ── 4. No driver found ────────────────────────────────────────────────
    logger.warn({ orderId }, '[Dispatch] No driver found after all retries');
    await this.cancelOrderNoDriver(orderId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Offer mechanics
  // ─────────────────────────────────────────────────────────────────────────

  private async offerToDrivers(
    order: Order,
    candidates: NearbyDriver[],
    attempt: number,
  ): Promise<string | null> {
    const env = getEnv();
    const timeoutSec = env.DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS / 1000;

    for (const driver of candidates) {
      const offerKey = RedisKey.dispatchOffer(order.id, driver.driverId);

      // Write offer to Redis — driver app polls / receives via socket
      await this.redis.set(offerKey, 'PENDING', 'EX', timeoutSec);

      // Emit new order request to the driver via WebSocket
      this.socketManager.emitToDriver(driver.driverId, SocketEvent.NEW_ORDER_REQUEST, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        pickupAddress: order.pickupAddress,
        dropoffAddress: order.dropoffAddress,
        distanceKm: driver.distanceMeters / 1000,
        estimatedFare: order.totalFare,
        currency: order.currency,
        vehicleType: driver.vehicleType,
        timeoutSec,
      });

      logger.debug(
        { orderId: order.id, driverId: driver.driverId, attempt },
        '[Dispatch] Offer sent — awaiting response',
      );

      // Poll Redis for driver's response
      const accepted = await this.waitForDriverResponse(
        order.id,
        driver.driverId,
        env.DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS,
      );

      if (accepted) return driver.driverId;
    }

    return null;
  }

  /**
   * Polls the Redis offer key every 500 ms until the driver responds
   * (ACCEPTED / REJECTED) or the timeout expires.
   */
  private async waitForDriverResponse(
    orderId: string,
    driverId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const offerKey = RedisKey.dispatchOffer(orderId, driverId);
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      const value = await this.redis.get(offerKey);

      if (value === 'ACCEPTED') {
        await this.redis.del(offerKey);
        return true;
      }
      if (value === 'REJECTED' || value === null) {
        // null = key expired (driver did not respond in time)
        return false;
      }

      await sleep(pollInterval);
    }

    return false; // timeout
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DB helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadOrder(orderId: string): Promise<Order | null> {
    return this.db.getRepository(Order).findOne({ where: { id: orderId } });
  }

  private async resolvePickupGeo(order: Order): Promise<GeoPoint> {
    // PostGIS returns geography columns as WKT — parse via ST_AsGeoJSON
    const rows = await this.db.query(
      `SELECT ST_AsGeoJSON(pickup_location) AS geojson FROM orders WHERE id = $1`,
      [order.id],
    );
    return GeoService.fromGeoJson(rows[0].geojson);
  }

  private async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.db.getRepository(Order).update(orderId, { status });
  }

  private async assignDriver(orderId: string, driverId: string): Promise<void> {
    await this.db.transaction(async (em) => {
      await em.update(Order, orderId, {
        driverId,
        status: OrderStatus.DRIVER_ASSIGNED,
        driverAssignedAt: new Date(),
      });
    });

    this.socketManager.notifyOrderAssigned(orderId, driverId);
    this.socketManager.notifyOrderStatusChange(orderId, OrderStatus.DRIVER_ASSIGNED);
  }

  private async cancelOrderNoDriver(orderId: string): Promise<void> {
    await this.db.getRepository(Order).update(orderId, {
      status: OrderStatus.CANCELLED,
      cancellationReason: CancellationReason.NO_DRIVER_FOUND,
      cancelledBy: 'system',
      cancelledAt: new Date(),
    });
    this.socketManager.notifyOrderStatusChange(orderId, OrderStatus.CANCELLED);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
