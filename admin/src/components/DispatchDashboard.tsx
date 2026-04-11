/**
 * @file DispatchDashboard.tsx
 * Root admin dispatch view — composes DispatchMap + OrderQueue
 * with a shared useLiveDrivers connection.
 *
 * Layout (desktop):
 *   ┌──────────────────────────────┬─────────────────────────┐
 *   │                              │                         │
 *   │      DispatchMap             │     OrderQueue          │
 *   │      (60% width)             │     (40% width)         │
 *   │                              │                         │
 *   └──────────────────────────────┴─────────────────────────┘
 *
 * Manual reassign flow:
 *   1. Admin clicks a driver marker on the map → driver panel opens (right sidebar).
 *   2. OR admin clicks "Force Reassign" on an order card → modal opens.
 */

import React, { useState } from 'react';
import { DispatchMap } from './DispatchMap';
import { OrderQueue, type Order } from './OrderQueue';
import { useLiveDrivers, type DriverState } from '../hooks/useLiveDrivers';

interface DispatchDashboardProps {
  mapboxToken: string;
  serverUrl: string;
  apiBaseUrl: string;
  accessToken: string;
  initialOrders: Order[];
}

export function DispatchDashboard({
  mapboxToken,
  serverUrl,
  apiBaseUrl,
  accessToken,
  initialOrders,
}: DispatchDashboardProps) {
  const [selectedDriver, setSelectedDriver] = useState<DriverState | null>(null);

  const { drivers, orderEvents, isConnected } = useLiveDrivers(serverUrl, accessToken);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-6 gap-4 z-10">
        <h1 className="text-lg font-bold text-gray-900 tracking-tight">Dispatch Control</h1>
        <div className={`flex items-center gap-1.5 text-xs font-medium
          ${isConnected ? 'text-green-600' : 'text-red-500'}`}>
          <span className={`w-2 h-2 rounded-full
            ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          {isConnected ? `${drivers.size} online` : 'Disconnected'}
        </div>
      </header>

      {/* ── Main layout ────────────────────────────────────────────────── */}
      <main className="flex flex-1 min-h-0 gap-4 p-4">
        {/* Map (left) */}
        <div className="flex-1 min-h-0">
          <DispatchMap
            mapboxToken={mapboxToken}
            serverUrl={serverUrl}
            accessToken={accessToken}
            onDriverSelect={setSelectedDriver}
          />
        </div>

        {/* Right panel */}
        <div className="w-[420px] flex flex-col gap-4 min-h-0">
          {/* Selected driver info */}
          {selectedDriver && (
            <div className="bg-white rounded-xl border border-blue-200 p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-gray-800">Selected Driver</h3>
                <button
                  onClick={() => setSelectedDriver(null)}
                  className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                >
                  ×
                </button>
              </div>
              <div className="space-y-1 text-xs text-gray-600">
                <div className="flex justify-between">
                  <span className="text-gray-400">ID</span>
                  <span className="font-mono truncate max-w-[200px]">{selectedDriver.driverId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Status</span>
                  <span className={`font-medium ${
                    selectedDriver.onlineStatus === 'AVAILABLE' ? 'text-green-600' : 'text-blue-600'
                  }`}>{selectedDriver.onlineStatus}</span>
                </div>
                {selectedDriver.speedKmh !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Speed</span>
                    <span>{selectedDriver.speedKmh.toFixed(1)} km/h</span>
                  </div>
                )}
                {selectedDriver.activeOrderId && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Active Order</span>
                    <span className="font-mono text-blue-700">{selectedDriver.activeOrderId.slice(0, 8)}…</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Order queue */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <h2 className="text-sm font-bold text-gray-700 mb-3 px-1">Order Queue</h2>
            <div className="h-full overflow-auto">
              <OrderQueue
                initialOrders={initialOrders}
                liveEvents={orderEvents}
                accessToken={accessToken}
                apiBaseUrl={apiBaseUrl}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
