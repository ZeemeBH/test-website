/**
 * @file socket.ts
 * Socket.io server bootstrap — authentication, room architecture, and
 * the complete location_ping event pipeline.
 *
 * ── Design overview ────────────────────────────────────────────────────────
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │ CLIENT (Driver App)                                                 │
 *  │   io({ auth: { token: '<JWT>' } })                                  │
 *  │   emit('location_ping', { lat, lng, heading, speed })               │
 *  └───────────────────────────────┬─────────────────────────────────────┘
 *                                  │ WebSocket
 *  ┌───────────────────────────────▼─────────────────────────────────────┐
 *  │ SOCKET.IO SERVER                                                    │
 *  │  1. JWT middleware — verify access token, inject userId + role      │
 *  │  2. connection handler                                              │
 *  │     a. auto-join personal room  user:{userId}                       │
 *  │     b. if DRIVER: join          driver:{driverId}                   │
 *  │  3. location_ping listener                                          │
 *  │     a. RedisLocationService.processPing()  ← fast Redis write       │
 *  │     b. throttle check (1 Hz)                                        │
 *  │     c. look up active orderId from Redis                            │
 *  │     d. emit driver:location:broadcast to order:{orderId} room       │
 *  │                                                                     │
 *  │  ROOMS:                                                             │
 *  │    user:{userId}       personal channel for any user                │
 *  │    driver:{driverId}   personal channel for drivers                 │
 *  │    order:{orderId}     shared room (customer + driver) for an order │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 * ── Throttle & TTL strategy ────────────────────────────────────────────────
 *
 *  PING FREQUENCY  : Drivers emit every 3-5 s (configurable in mobile app).
 *  REDIS WRITE     : Every ping → GEOADD + SETEX (presence key, TTL 60 s).
 *                    No DB write on this path.
 *  BROADCAST RATE  : Max 1 per second per driver via SET NX PX 1000.
 *                    Excess pings are accepted into Redis but NOT forwarded
 *                    to the customer room, preventing WebSocket flooding.
 *  POSTGRES FLUSH  : Debounced 10 s batch UPDATE via RedisLocationService.
 *  GHOST-DRIVER TTL: If driver stops pinging, presence key expires after 60 s.
 *                    Lua sweep removes them from the geo sorted set.
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { getEnv } from './environment';
import { RedisLocationService } from '../services/location/redisLocation.service';
import { GeoService } from '../services/geo/GeoService';
import { SocketEvent } from '../types/enums';
import type { JwtAccessPayload, DriverLocationPayload } from '../types/interfaces';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Augmented socket type with decoded JWT fields
// ─────────────────────────────────────────────────────────────────────────────

interface AppSocket extends Socket {
  /** Decoded from JWT — equals User.id */
  userId: string;
  /** 'CUSTOMER' | 'DRIVER' | 'ADMIN' */
  userRole: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory function — wires Socket.io onto an existing HTTP server
// ─────────────────────────────────────────────────────────────────────────────

export function attachSocketServer(
  httpServer: HttpServer,
  redis: Redis,
  db: DataSource,
): Server {
  const env = getEnv();
  const geo = new GeoService(db);
  const locationSvc = new RedisLocationService(redis, db, geo);

  // Start the ghost-driver background sweep (every 30 s)
  locationSvc.startSweep(30_000);

  // ── Socket.io server ───────────────────────────────────────────────────────
  const io = new Server(httpServer, {
    cors: {
      // In production restrict this to your frontend origin(s)
      origin: env.NODE_ENV === 'production' ? env.API_BASE_URL : '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 20_000,   // server waits 20 s for pong before closing
    pingInterval: 25_000,  // server sends ping every 25 s
    maxHttpBufferSize: 1e5, // 100 KB max message
  });

  // ── JWT Authentication middleware ──────────────────────────────────────────
  //
  // Clients MUST pass their access token in the Socket.io handshake:
  //   const socket = io(SERVER_URL, { auth: { token: accessToken } });
  //
  // The middleware runs before the 'connection' event fires, so unauthenticated
  // connections are rejected before any room joins or event listeners are set up.
  io.use((socket: Socket, next) => {
    const token = (socket.handshake.auth as { token?: string }).token
      ?? socket.handshake.headers['x-auth-token'] as string | undefined;

    if (!token) {
      logger.debug({ id: socket.id }, '[Socket] Rejected — no token');
      return next(new Error('AUTH_MISSING: Provide auth.token in the Socket.io handshake'));
    }

    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtAccessPayload;
      const appSocket = socket as AppSocket;
      appSocket.userId = payload.sub;
      appSocket.userRole = payload.role;
      next();
    } catch (err) {
      const isExpired = err instanceof jwt.TokenExpiredError;
      logger.debug({ id: socket.id }, `[Socket] Rejected — ${isExpired ? 'expired' : 'invalid'} token`);
      next(new Error(isExpired ? 'AUTH_EXPIRED: Token has expired' : 'AUTH_INVALID: Bad token'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as AppSocket;
    logger.info(
      { userId: socket.userId, role: socket.userRole, socketId: socket.id },
      '[Socket] Client connected',
    );

    // Every authenticated socket gets a personal room automatically
    void socket.join(`user:${socket.userId}`);

    if (socket.userRole === 'DRIVER') {
      registerDriverSocket(socket, io, locationSvc, redis);
    } else {
      registerCustomerSocket(socket);
    }

    socket.on('disconnect', (reason) => {
      logger.info({ userId: socket.userId, reason }, '[Socket] Client disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ err, userId: socket.userId }, '[Socket] Socket error');
    });
  });

  return io;
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver socket registration
// ─────────────────────────────────────────────────────────────────────────────

function registerDriverSocket(
  socket: AppSocket,
  io: Server,
  locationSvc: RedisLocationService,
  redis: Redis,
): void {
  const driverId = socket.userId;

  // Join driver personal room (used for dispatch offers)
  void socket.join(`driver:${driverId}`);

  // ── location_ping ──────────────────────────────────────────────────────────
  //
  // This is the hot path — fires every 3-5 seconds per driver.
  //
  // Pipeline:
  //  1. Validate + write to Redis Geo + refresh presence TTL
  //  2. Check broadcast throttle (1 Hz gate)
  //  3. Lookup active order from Redis binding
  //  4. Emit to order room ONLY (not broadcast to all clients)
  socket.on('location_ping', async (data: { lat: number; lng: number; heading?: number; speed?: number }) => {
    // Construct payload — ALWAYS use server-authenticated driverId,
    // never trust the client-supplied one
    const payload: DriverLocationPayload = {
      driverId,
      location: { type: 'Point', coordinates: [data.lng, data.lat] },
      heading: data.heading,
      speedKmh: data.speed,
      timestamp: Date.now(),
    };

    // Step 1: write to Redis (returns false if coordinates are invalid)
    const accepted = await locationSvc.processPing(payload);
    if (!accepted) {
      socket.emit(SocketEvent.ERROR, { message: 'Invalid coordinates' });
      return;
    }

    // Step 2: broadcast throttle — max 1 customer notification per second
    const canBroadcast = await locationSvc.acquireBroadcastSlot(driverId);
    if (!canBroadcast) {
      // Location is stored in Redis (step 1 succeeded) but we skip the
      // Socket.io emission to avoid flooding the customer's screen.
      return;
    }

    // Step 3: find the driver's active order room binding
    const orderId = await locationSvc.getActiveOrderForDriver(driverId);
    if (!orderId) return; // driver is online but not currently on a job

    // Step 4: emit exclusively to the order room (customer + driver only)
    //
    // The order room `order:{orderId}` is joined by:
    //   - The customer when the order is assigned (see joinOrderRoom below)
    //   - The driver above (driver:{driverId} join happens at connection)
    //
    // No other clients receive this event.
    io.to(`order:${orderId}`).emit(SocketEvent.DRIVER_LOCATION_BROADCAST, payload);
  });

  // ── Go Online ──────────────────────────────────────────────────────────────
  socket.on('driver:go_online', async (data: { lat: number; lng: number }) => {
    try {
      const location: DriverLocationPayload['location'] = {
        type: 'Point',
        coordinates: [data.lng, data.lat],
      };
      await locationSvc.markOnline(driverId, location);
      socket.emit('driver:online_ack', { status: 'online' });
      logger.info({ driverId }, '[Socket] Driver went online');
    } catch (err) {
      logger.error({ err, driverId }, '[Socket] go_online failed');
      socket.emit(SocketEvent.ERROR, { message: 'Failed to go online' });
    }
  });

  // ── Go Offline ─────────────────────────────────────────────────────────────
  socket.on('driver:go_offline', async () => {
    try {
      await locationSvc.markOffline(driverId);
      socket.emit('driver:offline_ack', { status: 'offline' });
      logger.info({ driverId }, '[Socket] Driver went offline');
    } catch (err) {
      logger.error({ err, driverId }, '[Socket] go_offline failed');
    }
  });

  // ── Accept order offer ─────────────────────────────────────────────────────
  socket.on(SocketEvent.DRIVER_ACCEPT_ORDER, async (data: { orderId: string }) => {
    const offerKey = `dispatch:offer:${data.orderId}:${driverId}`;
    const exists = await redis.exists(offerKey);

    if (!exists) {
      socket.emit(SocketEvent.ERROR, { message: 'Offer not found or expired' });
      return;
    }

    await redis.set(offerKey, 'ACCEPTED', 'KEEPTTL');

    // Bind driver ↔ order for location broadcast routing
    await locationSvc.bindDriverToOrder(driverId, data.orderId);

    // Driver joins the order room — customer was added at dispatch time
    void socket.join(`order:${data.orderId}`);

    logger.info({ driverId, orderId: data.orderId }, '[Socket] Driver accepted order');
  });

  // ── Reject order offer ─────────────────────────────────────────────────────
  socket.on(SocketEvent.DRIVER_REJECT_ORDER, async (data: { orderId: string }) => {
    const offerKey = `dispatch:offer:${data.orderId}:${driverId}`;
    await redis.set(offerKey, 'REJECTED', 'KEEPTTL');
    logger.info({ driverId, orderId: data.orderId }, '[Socket] Driver rejected offer');
  });

  // ── Order status updates (en-route, arrived, picked-up, delivered) ─────────
  socket.on(SocketEvent.DRIVER_ORDER_STATUS_UPDATE, async (data: { orderId: string; status: string }) => {
    // Relay to the order room so the customer sees the update in real-time
    io.to(`order:${data.orderId}`).emit(SocketEvent.ORDER_STATUS_CHANGED, {
      orderId: data.orderId,
      status: data.status,
      updatedAt: new Date().toISOString(),
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    // Mark offline immediately — no delay
    try {
      await locationSvc.markOffline(driverId);
    } catch (err) {
      logger.error({ err, driverId }, '[Socket] markOffline on disconnect failed');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer socket registration
// ─────────────────────────────────────────────────────────────────────────────

function registerCustomerSocket(socket: AppSocket): void {
  const customerId = socket.userId;

  // Customers join the order room when they are instructed to by the server
  // (the server emits 'join_room' after a driver accepts their order).
  socket.on('join_room', (data: { room: string }) => {
    // Validate: customers may only join rooms starting with 'order:'
    if (!data.room.startsWith('order:')) {
      socket.emit(SocketEvent.ERROR, { message: 'Invalid room' });
      return;
    }
    void socket.join(data.room);
    logger.debug({ customerId, room: data.room }, '[Socket] Customer joined order room');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported helper — call from DispatchEngine/OrderService to push customer
// into the order room at the moment a driver is assigned.
// ─────────────────────────────────────────────────────────────────────────────

export function joinOrderRoom(io: Server, orderId: string, customerId: string): void {
  // Tell the customer's personal socket to join the order room
  io.to(`user:${customerId}`).emit('join_room', { room: `order:${orderId}` });
  logger.debug({ orderId, customerId }, '[Socket] Customer invited to order room');
}
