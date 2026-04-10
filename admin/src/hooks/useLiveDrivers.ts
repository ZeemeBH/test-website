/**
 * @file useLiveDrivers.ts
 * WebSocket hook that connects to the Node.js backend and maintains
 * a live map of driver locations, statuses, and active orders.
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 *
 * 1. Connect to the Socket.io server with the admin's JWT access token.
 * 2. Listen for `driver:location:broadcast` events — each event updates
 *    the driver's position in local state.
 * 3. Listen for `order:status:changed` events — updates order status in
 *    local state without a full re-fetch.
 * 4. Expose helper functions the DispatchMap and OrderQueue use to render
 *    correct marker colours and status badges.
 *
 * ── State shape ───────────────────────────────────────────────────────────
 *
 *   drivers:   Map<driverId, DriverState>
 *   orders:    Map<orderId, OrderStatusEvent>
 *
 * ── Performance ───────────────────────────────────────────────────────────
 *
 * Driver positions arrive at ≤1 Hz per driver (throttled server-side).
 * With 200 online drivers that's 200 events/sec.  We use a functional
 * setState update to avoid stale closure issues and batch updates via the
 * React scheduler.
 *
 * Mapbox marker positions are updated via ref mutation (not a full React
 * re-render) in the DispatchMap component for best perf.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DriverOnlineStatus = 'AVAILABLE' | 'ON_JOB' | 'OFFLINE';

export interface DriverState {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
  timestamp: number;
  /** 'AVAILABLE' = green marker, 'ON_JOB' = blue marker */
  onlineStatus: DriverOnlineStatus;
  /** Present when driver has an active order */
  activeOrderId?: string;
}

export interface OrderStatusEvent {
  orderId: string;
  status: string;
  updatedAt: string;
  driver?: {
    id: string;
    firstName: string;
    location?: { coordinates: [number, number] };
  };
}

export interface UseLiveDriversReturn {
  /** Drivers keyed by driverId */
  drivers: Map<string, DriverState>;
  /** Recent order status events keyed by orderId */
  orderEvents: Map<string, OrderStatusEvent>;
  isConnected: boolean;
  connectionError: string | null;
  /** Returns the Mapbox marker colour for a driver's status */
  markerColour: (driverId: string) => string;
  /** Manually request a full driver snapshot (admin call) */
  refreshSnapshot: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker colours (Tailwind/Mapbox palette)
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_COLOUR: Record<DriverOnlineStatus, string> = {
  AVAILABLE: '#22c55e',  // green-500
  ON_JOB:    '#3b82f6',  // blue-500
  OFFLINE:   '#6b7280',  // gray-500
};

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useLiveDrivers(
  serverUrl: string,
  accessToken: string | null,
): UseLiveDriversReturn {
  const [drivers, setDrivers] = useState<Map<string, DriverState>>(new Map());
  const [orderEvents, setOrderEvents] = useState<Map<string, OrderStatusEvent>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);

  // ── Connect / reconnect when token changes ────────────────────────────────
  useEffect(() => {
    if (!accessToken) return;

    const socket = io(serverUrl, {
      auth: { token: accessToken },
      transports: ['websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2_000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setConnectionError(null);
      // Request initial snapshot of all online drivers
      socket.emit('admin:request_snapshot');
    });

    socket.on('disconnect', () => setIsConnected(false));

    socket.on('connect_error', (err) => {
      setConnectionError(err.message);
      setIsConnected(false);
    });

    // ── Driver location broadcast ─────────────────────────────────────────
    // Payload shape: { driverId, location: { coordinates: [lng, lat] },
    //                  heading, speedKmh, timestamp }
    socket.on('driver:location:broadcast', (payload: {
      driverId: string;
      location: { coordinates: [number, number] };
      heading?: number;
      speedKmh?: number;
      timestamp: number;
    }) => {
      setDrivers((prev) => {
        const next = new Map(prev);
        const existing = next.get(payload.driverId);
        next.set(payload.driverId, {
          driverId: payload.driverId,
          // GeoJSON: [lng, lat] — Mapbox uses [lng, lat] natively
          lng: payload.location.coordinates[0],
          lat: payload.location.coordinates[1],
          heading: payload.heading,
          speedKmh: payload.speedKmh,
          timestamp: payload.timestamp,
          // Preserve status from previous state or default to ON_JOB
          // (admin snapshot event fills in the accurate status)
          onlineStatus: existing?.onlineStatus ?? 'ON_JOB',
          activeOrderId: existing?.activeOrderId,
        });
        return next;
      });
    });

    // ── Admin snapshot (all online drivers at once) ───────────────────────
    socket.on('admin:snapshot', (snapshot: DriverState[]) => {
      const m = new Map<string, DriverState>();
      snapshot.forEach((d) => m.set(d.driverId, d));
      setDrivers(m);
    });

    // ── Driver status change (available / on-job / offline) ──────────────
    socket.on('driver:status:changed', (payload: { driverId: string; status: DriverOnlineStatus }) => {
      setDrivers((prev) => {
        const next = new Map(prev);
        const d = next.get(payload.driverId);
        if (d) next.set(payload.driverId, { ...d, onlineStatus: payload.status });
        return next;
      });
    });

    // ── Driver offline ────────────────────────────────────────────────────
    socket.on('driver:went_offline', (payload: { driverId: string }) => {
      setDrivers((prev) => {
        const next = new Map(prev);
        next.delete(payload.driverId);
        return next;
      });
    });

    // ── Order status changed ──────────────────────────────────────────────
    socket.on('order:status:changed', (payload: OrderStatusEvent) => {
      setOrderEvents((prev) => {
        const next = new Map(prev);
        next.set(payload.orderId, payload);
        return next;
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [serverUrl, accessToken]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const markerColour = useCallback(
    (driverId: string): string => {
      const status = drivers.get(driverId)?.onlineStatus ?? 'OFFLINE';
      return STATUS_COLOUR[status];
    },
    [drivers],
  );

  const refreshSnapshot = useCallback(() => {
    socketRef.current?.emit('admin:request_snapshot');
  }, []);

  return { drivers, orderEvents, isConnected, connectionError, markerColour, refreshSnapshot };
}
