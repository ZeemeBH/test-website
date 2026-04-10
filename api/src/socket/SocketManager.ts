/**
 * @file SocketManager.ts
 * Central Socket.io server — authentication, room management, and
 * broadcast helpers used by the service layer.
 *
 * ── Room architecture ──────────────────────────────────────────────────────
 *
 * Every connected socket is placed into one or more rooms:
 *
 *   user:{userId}          — one-to-one customer notifications
 *   driver:{driverId}      — one-to-one driver notifications
 *   order:{orderId}        — shared customer + driver room for a live order
 *                            (driver location pings sent here)
 *
 * ── Authentication ─────────────────────────────────────────────────────────
 *
 * Clients must send a valid JWT access token in the `auth.token` handshake
 * field.  The middleware verifies it before the connection is established.
 * Unauthenticated sockets are disconnected immediately.
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/environment';
import { SocketEvent, OrderStatus } from '../types/enums';
import type { JwtAccessPayload, DriverLocationPayload } from '../types/interfaces';
import { logger } from '../utils/logger';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userRole: string;
  driverId?: string;
}

export class SocketManager {
  public readonly io: Server;

  constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: '*', // Tighten in production with explicit origin list
        methods: ['GET', 'POST'],
        credentials: true,
      },
      // Prefer WebSocket, fall back to polling
      transports: ['websocket', 'polling'],
      pingTimeout: 20_000,
      pingInterval: 25_000,
    });

    this.attachAuthMiddleware();
    this.attachConnectionHandlers();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication middleware
  // ─────────────────────────────────────────────────────────────────────────

  private attachAuthMiddleware(): void {
    this.io.use((socket, next) => {
      const token = (socket.handshake.auth as { token?: string }).token;

      if (!token) {
        return next(new Error('Authentication token missing'));
      }

      try {
        const payload = jwt.verify(token, getEnv().JWT_ACCESS_SECRET) as JwtAccessPayload;
        const auth = socket as AuthenticatedSocket;
        auth.userId = payload.sub;
        auth.userRole = payload.role;
        next();
      } catch {
        next(new Error('Invalid or expired authentication token'));
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connection handlers
  // ─────────────────────────────────────────────────────────────────────────

  private attachConnectionHandlers(): void {
    this.io.on('connection', (rawSocket: Socket) => {
      const socket = rawSocket as AuthenticatedSocket;
      logger.debug({ userId: socket.userId, role: socket.userRole }, '[Socket] Client connected');

      // Auto-join personal room
      void socket.join(`user:${socket.userId}`);

      socket.on('disconnect', (reason) => {
        logger.debug({ userId: socket.userId, reason }, '[Socket] Client disconnected');
      });

      socket.on('error', (err) => {
        logger.error({ err, userId: socket.userId }, '[Socket] Socket error');
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Room management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Joins both the customer and driver sockets into the order room.
   * Called when a driver accepts an order.
   */
  joinOrderRoom(orderId: string, customerId: string, driverId: string): void {
    const room = `order:${orderId}`;
    // Emit join instruction — clients receive this and call socket.join()
    this.io.to(`user:${customerId}`).emit('join_room', { room });
    this.io.to(`driver:${driverId}`).emit('join_room', { room });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Broadcast helpers (used by services)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Broadcasts a driver's location update exclusively to the order room.
   * This is the "Customer sees car moving" event.
   */
  broadcastDriverLocation(orderId: string, payload: DriverLocationPayload): void {
    this.io.to(`order:${orderId}`).emit(SocketEvent.DRIVER_LOCATION_BROADCAST, payload);
  }

  /**
   * Notifies the customer room that the order status has changed.
   */
  notifyOrderStatusChange(orderId: string, status: OrderStatus): void {
    this.io.to(`order:${orderId}`).emit(SocketEvent.ORDER_STATUS_CHANGED, {
      orderId,
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Sends a new order offer to a specific driver.
   */
  emitToDriver(driverId: string, event: SocketEvent, data: unknown): void {
    this.io.to(`driver:${driverId}`).emit(event, data);
  }

  /**
   * Notifies all parties when an order is assigned to a driver.
   */
  notifyOrderAssigned(orderId: string, driverId: string): void {
    this.io.to(`order:${orderId}`).emit(SocketEvent.ORDER_ASSIGNED, {
      orderId,
      driverId,
      assignedAt: new Date().toISOString(),
    });
  }

  /**
   * Broadcasts order cancellation to the order room.
   */
  notifyOrderCancelled(orderId: string, reason: string): void {
    this.io.to(`order:${orderId}`).emit(SocketEvent.ORDER_CANCELLED, {
      orderId,
      reason,
      cancelledAt: new Date().toISOString(),
    });
  }

  /**
   * Registers a socket's driver ID so it can receive driver-room events.
   * Called from the driver location handler after WebSocket auth.
   */
  registerDriverSocket(socket: Socket, driverId: string): void {
    void socket.join(`driver:${driverId}`);
    (socket as AuthenticatedSocket).driverId = driverId;
  }
}
