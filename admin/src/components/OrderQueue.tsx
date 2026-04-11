/**
 * @file OrderQueue.tsx
 * Kanban/list order queue with manual driver reassignment.
 *
 * ── Columns ───────────────────────────────────────────────────────────────
 *   Pending          — PENDING, SEARCHING_DRIVER
 *   Finding Driver   — SEARCHING_DRIVER (actively dispatching)
 *   In Transit       — DRIVER_ASSIGNED, DRIVER_EN_ROUTE, DRIVER_ARRIVED,
 *                      PICKED_UP, IN_TRANSIT
 *   Completed        — DELIVERED, CANCELLED, FAILED
 *
 * ── Manual Override ───────────────────────────────────────────────────────
 * Admin clicks "Reassign" on any In Transit order → modal opens.
 * Admin enters a Driver ID → POST /api/v1/admin/orders/:id/reassign.
 * The modal is implemented inline for minimal dependencies.
 *
 * ── Data fetching ─────────────────────────────────────────────────────────
 * Initial data is fetched via REST (GET /api/v1/admin/orders).
 * Live updates from the useLiveDrivers hook's orderEvents map are merged in
 * to avoid full re-fetches on every status change.
 */

import React, { useState, useCallback, useEffect } from 'react';
import type { OrderStatusEvent } from '../hooks/useLiveDrivers';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Order {
  id: string;
  orderNumber: string;
  status: string;
  customerId: string;
  driverId?: string;
  pickupAddress: { line1: string; city: string };
  dropoffAddress: { line1: string; city: string };
  totalFare: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

interface OrderQueueProps {
  /** Pre-fetched orders (REST) — merged with live WebSocket events */
  initialOrders: Order[];
  /** Live status events from useLiveDrivers */
  liveEvents: Map<string, OrderStatusEvent>;
  /** Admin JWT for the reassign API call */
  accessToken: string;
  /** Backend base URL */
  apiBaseUrl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status → column mapping
// ─────────────────────────────────────────────────────────────────────────────

type ColumnId = 'PENDING' | 'FINDING_DRIVER' | 'IN_TRANSIT' | 'COMPLETED';

const STATUS_TO_COLUMN: Record<string, ColumnId> = {
  PENDING:         'PENDING',
  SEARCHING_DRIVER:'FINDING_DRIVER',
  DRIVER_ASSIGNED: 'IN_TRANSIT',
  DRIVER_EN_ROUTE: 'IN_TRANSIT',
  DRIVER_ARRIVED:  'IN_TRANSIT',
  PICKED_UP:       'IN_TRANSIT',
  IN_TRANSIT:      'IN_TRANSIT',
  DELIVERED:       'COMPLETED',
  CANCELLED:       'COMPLETED',
  FAILED:          'COMPLETED',
};

const COLUMN_LABELS: Record<ColumnId, string> = {
  PENDING:       'Pending',
  FINDING_DRIVER:'Finding Driver',
  IN_TRANSIT:    'In Transit',
  COMPLETED:     'Completed',
};

const COLUMN_HEADER_COLOURS: Record<ColumnId, string> = {
  PENDING:       'bg-yellow-100 text-yellow-800 border-yellow-300',
  FINDING_DRIVER:'bg-orange-100 text-orange-800 border-orange-300',
  IN_TRANSIT:    'bg-blue-100   text-blue-800   border-blue-300',
  COMPLETED:     'bg-green-100  text-green-800  border-green-300',
};

const STATUS_BADGE: Record<string, string> = {
  PENDING:         'bg-yellow-100 text-yellow-700',
  SEARCHING_DRIVER:'bg-orange-100 text-orange-700',
  DRIVER_ASSIGNED: 'bg-blue-50   text-blue-700',
  DRIVER_EN_ROUTE: 'bg-blue-100  text-blue-800',
  DRIVER_ARRIVED:  'bg-indigo-100 text-indigo-700',
  PICKED_UP:       'bg-purple-100 text-purple-700',
  IN_TRANSIT:      'bg-blue-200  text-blue-900',
  DELIVERED:       'bg-green-100 text-green-700',
  CANCELLED:       'bg-gray-100  text-gray-600',
  FAILED:          'bg-red-100   text-red-700',
};

// ─────────────────────────────────────────────────────────────────────────────
// Reassign modal
// ─────────────────────────────────────────────────────────────────────────────

interface ReassignModalProps {
  order: Order;
  accessToken: string;
  apiBaseUrl: string;
  onSuccess: (orderId: string, newDriverId: string) => void;
  onClose: () => void;
}

function ReassignModal({ order, accessToken, apiBaseUrl, onSuccess, onClose }: ReassignModalProps) {
  const [newDriverId, setNewDriverId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDriverId.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${apiBaseUrl}/orders/${order.id}/reassign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ driverId: newDriverId.trim() }),
      });

      const data = await res.json() as { success: boolean; message?: string };

      if (!data.success) {
        setError(data.message ?? 'Reassignment failed');
        return;
      }

      onSuccess(order.id, newDriverId.trim());
      onClose();
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [newDriverId, order.id, accessToken, apiBaseUrl, onSuccess, onClose]);

  return (
    // Backdrop
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Force Reassign Driver</h2>
            <p className="text-sm text-gray-500 mt-0.5">Order {order.orderNumber}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        {/* Current driver */}
        {order.driverId && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm">
            <p className="font-medium text-red-700">Current driver will be unassigned</p>
            <p className="text-red-500 font-mono text-xs mt-0.5 truncate">{order.driverId}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              New Driver ID
            </label>
            <input
              type="text"
              value={newDriverId}
              onChange={(e) => setNewDriverId(e.target.value)}
              placeholder="Enter driver UUID"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm
                         font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !newDriverId.trim()}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm
                         font-medium hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {loading ? 'Reassigning…' : 'Confirm Reassign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Order card
// ─────────────────────────────────────────────────────────────────────────────

interface OrderCardProps {
  order: Order;
  onReassign: (order: Order) => void;
}

function OrderCard({ order, onReassign }: OrderCardProps) {
  const column = STATUS_TO_COLUMN[order.status] ?? 'PENDING';
  const showReassign = column === 'IN_TRANSIT';

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3
                    hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-bold text-gray-600">{order.orderNumber}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[order.status] ?? 'bg-gray-100 text-gray-600'}`}>
          {order.status.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Route */}
      <div className="space-y-1 text-xs text-gray-600">
        <div className="flex gap-2 items-start">
          <span className="w-4 h-4 rounded-full bg-green-500 flex-shrink-0 mt-0.5
                           flex items-center justify-center text-white text-[9px] font-bold">P</span>
          <span className="truncate">{order.pickupAddress.line1}, {order.pickupAddress.city}</span>
        </div>
        <div className="flex gap-2 items-start">
          <span className="w-4 h-4 rounded-full bg-red-500 flex-shrink-0 mt-0.5
                           flex items-center justify-center text-white text-[9px] font-bold">D</span>
          <span className="truncate">{order.dropoffAddress.line1}, {order.dropoffAddress.city}</span>
        </div>
      </div>

      {/* Fare */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">{new Date(order.createdAt).toLocaleTimeString()}</span>
        <span className="font-semibold text-gray-800">
          {order.currency} {Number(order.totalFare).toFixed(order.currency === 'BHD' ? 3 : 2)}
        </span>
      </div>

      {/* Driver info */}
      {order.driverId && (
        <div className="text-xs text-gray-400 font-mono truncate">
          Driver: {order.driverId.slice(0, 12)}…
        </div>
      )}

      {/* Action */}
      {showReassign && (
        <button
          onClick={() => onReassign(order)}
          className="w-full text-xs font-medium text-white bg-blue-600 hover:bg-blue-700
                     rounded-lg py-1.5 transition"
        >
          Force Reassign
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function OrderQueue({ initialOrders, liveEvents, accessToken, apiBaseUrl }: OrderQueueProps) {
  const [orders, setOrders] = useState<Map<string, Order>>(() => {
    const m = new Map<string, Order>();
    initialOrders.forEach((o) => m.set(o.id, o));
    return m;
  });
  const [reassignTarget, setReassignTarget] = useState<Order | null>(null);

  // Merge live status events into local order state
  useEffect(() => {
    if (liveEvents.size === 0) return;
    setOrders((prev) => {
      const next = new Map(prev);
      liveEvents.forEach((event) => {
        const existing = next.get(event.orderId);
        if (existing) {
          next.set(event.orderId, { ...existing, status: event.status, updatedAt: event.updatedAt });
        }
      });
      return next;
    });
  }, [liveEvents]);

  // Group orders by column
  const columns = React.useMemo(() => {
    const groups: Record<ColumnId, Order[]> = {
      PENDING: [], FINDING_DRIVER: [], IN_TRANSIT: [], COMPLETED: [],
    };
    orders.forEach((order) => {
      const col = STATUS_TO_COLUMN[order.status] ?? 'PENDING';
      groups[col].push(order);
    });
    // Sort each column by newest first
    (Object.keys(groups) as ColumnId[]).forEach((col) => {
      groups[col].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });
    return groups;
  }, [orders]);

  const handleReassignSuccess = useCallback((orderId: string, newDriverId: string) => {
    setOrders((prev) => {
      const next = new Map(prev);
      const o = next.get(orderId);
      if (o) next.set(orderId, { ...o, driverId: newDriverId });
      return next;
    });
  }, []);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 h-full">
        {(Object.keys(COLUMN_LABELS) as ColumnId[]).map((col) => (
          <div key={col} className="flex flex-col gap-3 min-h-0">
            {/* Column header */}
            <div className={`flex items-center justify-between px-3 py-2 rounded-xl
                             border ${COLUMN_HEADER_COLOURS[col]} font-semibold text-sm`}>
              <span>{COLUMN_LABELS[col]}</span>
              <span className="bg-white/60 rounded-full px-2 text-xs font-bold">
                {columns[col].length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {columns[col].length === 0 ? (
                <p className="text-center text-xs text-gray-400 py-6">No orders</p>
              ) : (
                columns[col].map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onReassign={setReassignTarget}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Reassign modal */}
      {reassignTarget && (
        <ReassignModal
          order={reassignTarget}
          accessToken={accessToken}
          apiBaseUrl={apiBaseUrl}
          onSuccess={handleReassignSuccess}
          onClose={() => setReassignTarget(null)}
        />
      )}
    </>
  );
}
