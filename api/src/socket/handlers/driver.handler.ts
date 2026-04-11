/**
 * @file driver.handler.ts
 * Handles all driver-originated WebSocket events:
 *  - DRIVER_LOCATION_UPDATE   → update Redis geo + throttled broadcast
 *  - DRIVER_STATUS_UPDATE     → toggle online/available
 *  - DRIVER_ACCEPT_ORDER      → write ACCEPTED to dispatch offer key
 *  - DRIVER_REJECT_ORDER      → write REJECTED to dispatch offer key
 *  - DRIVER_ORDER_STATUS_UPDATE → status progression (EN_ROUTE, ARRIVED, etc.)
 */

import { Socket } from 'socket.io';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { SocketEvent } from '../../types/enums';
import type { DriverLocationPayload } from '../../types/interfaces';
import type { LocationTracker } from '../../services/location/LocationTracker';
import type { SocketManager } from '../SocketManager';
import { RedisKey } from '../../config/redis';
import { Driver } from '../../entities/Driver.entity';
import { logger } from '../../utils/logger';

export function registerDriverHandlers(
  socket: Socket,
  driverId: string,
  locationTracker: LocationTracker,
  socketManager: SocketManager,
  redis: Redis,
  db: DataSource,
): void {

  // ── location_ping ─────────────────────────────────────────────────────────
  socket.on(SocketEvent.DRIVER_LOCATION_UPDATE, async (payload: DriverLocationPayload) => {
    // Attach the authenticated driverId — never trust the client-supplied one
    const safePayload: DriverLocationPayload = {
      ...payload,
      driverId,
      timestamp: Date.now(),
    };

    const accepted = await locationTracker.handlePing(safePayload);
    if (!accepted) return;

    // Rate-limit broadcast to order room (1 s per driver)
    const canBroadcast = await locationTracker.shouldBroadcast(driverId);
    if (!canBroadcast) return;

    // Determine if this driver has an active order and broadcast to that room
    const activeOrderId = await getActiveOrderId(driverId, db);
    if (activeOrderId) {
      socketManager.broadcastDriverLocation(activeOrderId, safePayload);
    }
  });

  // ── Driver status update (go online / go offline) ─────────────────────────
  socket.on(
    SocketEvent.DRIVER_STATUS_UPDATE,
    async (data: { isOnline: boolean; isAvailable: boolean }) => {
      try {
        await db.getRepository(Driver).update(driverId, {
          isOnline: data.isOnline,
          isAvailable: data.isAvailable,
        });

        if (data.isOnline) {
          await locationTracker.markDriverOnline(driverId);
          socketManager.registerDriverSocket(socket, driverId);
        } else {
          await locationTracker.markDriverOffline(driverId);
        }

        logger.debug({ driverId, ...data }, '[DriverHandler] Status updated');
      } catch (err) {
        logger.error({ err, driverId }, '[DriverHandler] Status update failed');
        socket.emit(SocketEvent.ERROR, { message: 'Failed to update status' });
      }
    },
  );

  // ── Accept order offer ────────────────────────────────────────────────────
  socket.on(SocketEvent.DRIVER_ACCEPT_ORDER, async (data: { orderId: string }) => {
    const offerKey = RedisKey.dispatchOffer(data.orderId, driverId);
    const exists = await redis.exists(offerKey);

    if (!exists) {
      socket.emit(SocketEvent.ERROR, { message: 'Offer expired or not found' });
      return;
    }

    await redis.set(offerKey, 'ACCEPTED', 'KEEPTTL');
    logger.info({ driverId, orderId: data.orderId }, '[DriverHandler] Order accepted');
  });

  // ── Reject order offer ────────────────────────────────────────────────────
  socket.on(SocketEvent.DRIVER_REJECT_ORDER, async (data: { orderId: string }) => {
    const offerKey = RedisKey.dispatchOffer(data.orderId, driverId);
    await redis.set(offerKey, 'REJECTED', 'KEEPTTL');
    logger.info({ driverId, orderId: data.orderId }, '[DriverHandler] Order rejected');
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    await locationTracker.markDriverOffline(driverId);
    await db.getRepository(Driver).update(driverId, { isOnline: false, isAvailable: false });
    logger.info({ driverId }, '[DriverHandler] Driver went offline');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — find the currently active order for a driver
// ─────────────────────────────────────────────────────────────────────────────

async function getActiveOrderId(driverId: string, db: DataSource): Promise<string | null> {
  const row = await db.query(
    `SELECT id FROM orders
     WHERE driver_id = $1
       AND status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','PICKED_UP','IN_TRANSIT')
     LIMIT 1`,
    [driverId],
  );
  return row[0]?.id ?? null;
}
