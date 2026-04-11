/**
 * @file DispatchMap.tsx
 * Real-time fleet map for the Admin Dispatch Dashboard.
 *
 * ── Tech ──────────────────────────────────────────────────────────────────
 * - react-map-gl (Mapbox GL JS wrapper)
 * - socket.io-client via useLiveDrivers hook
 * - Tailwind CSS for chrome outside the map viewport
 *
 * ── Marker strategy ───────────────────────────────────────────────────────
 * Each online driver is rendered as a Mapbox `Marker` component.
 * We update markers via state (Map<driverId, DriverState>) which React
 * reconciles efficiently — only changed drivers trigger a marker re-render.
 *
 * At high scale (1000+ drivers), replace Marker components with a
 * mapbox-gl Layer (GeoJSON source) for hardware-accelerated rendering.
 *
 * ── Marker colours ────────────────────────────────────────────────────────
 *   ● Green  (#22c55e) — AVAILABLE: driver is online with no active order
 *   ● Blue   (#3b82f6) — ON_JOB:   driver is en-route or delivering
 *   ● Gray   (#6b7280) — fallback for transitional states
 */

import React, { useCallback, useState, useRef } from 'react';
import Map, { Marker, Popup, NavigationControl, MapRef } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useLiveDrivers, type DriverState } from '../hooks/useLiveDrivers';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface DispatchMapProps {
  /** Mapbox public token from env */
  mapboxToken: string;
  /** Backend URL for Socket.io */
  serverUrl: string;
  /** Admin JWT access token */
  accessToken: string;
  /** Called when admin clicks a driver marker — for manual reassignment */
  onDriverSelect?: (driver: DriverState) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Default centre: Manama, Bahrain
const DEFAULT_VIEWPORT = {
  longitude: 50.586,
  latitude: 26.215,
  zoom: 11,
};

// ─────────────────────────────────────────────────────────────────────────────
// Driver SVG marker
// ─────────────────────────────────────────────────────────────────────────────

interface DriverMarkerIconProps {
  colour: string;
  heading?: number;   // degrees 0-359
  isSelected: boolean;
}

function DriverMarkerIcon({ colour, heading, isSelected }: DriverMarkerIconProps) {
  const rotation = heading ?? 0;
  return (
    <div
      style={{ transform: `rotate(${rotation}deg)` }}
      className={`transition-transform duration-300 ease-linear
        ${isSelected ? 'scale-150 drop-shadow-lg' : 'scale-100'}`}
    >
      {/* Car-shaped SVG pin */}
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Drop shadow */}
        <ellipse cx="14" cy="26" rx="6" ry="2" fill="rgba(0,0,0,0.15)" />
        {/* Body */}
        <path
          d="M14 2C10 2 6 6 6 11v8l2 3h12l2-3v-8c0-5-4-9-8-9z"
          fill={colour}
          stroke="#fff"
          strokeWidth="1.5"
        />
        {/* Windscreen */}
        <path d="M10 11h8v4H10z" fill="rgba(255,255,255,0.6)" rx="1" />
        {/* Heading arrow */}
        <path d="M14 3 L17 8 L14 7 L11 8 Z" fill="white" opacity="0.9" />
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function DispatchMap({
  mapboxToken,
  serverUrl,
  accessToken,
  onDriverSelect,
}: DispatchMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);
  const [popupDriver, setPopupDriver] = useState<DriverState | null>(null);

  const { drivers, isConnected, connectionError, markerColour, refreshSnapshot } =
    useLiveDrivers(serverUrl, accessToken);

  // ── Click handler ─────────────────────────────────────────────────────────

  const handleMarkerClick = useCallback(
    (driver: DriverState) => {
      setSelectedDriver(driver.driverId);
      setPopupDriver(driver);
      onDriverSelect?.(driver);

      // Pan map to clicked driver
      mapRef.current?.flyTo({
        center: [driver.lng, driver.lat],
        zoom: 14,
        duration: 800,
      });
    },
    [onDriverSelect],
  );

  const closePopup = useCallback(() => {
    setSelectedDriver(null);
    setPopupDriver(null);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-gray-200 shadow-lg">

      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3
                      bg-white/90 backdrop-blur-sm px-4 py-2 rounded-full shadow text-sm">
        <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
        <span className="font-medium text-gray-700">
          {isConnected ? `${drivers.size} drivers online` : 'Connecting…'}
        </span>
        {connectionError && (
          <span className="text-red-600 text-xs">{connectionError}</span>
        )}
        <button
          onClick={refreshSnapshot}
          className="ml-2 text-xs text-blue-600 hover:underline"
        >
          Refresh
        </button>
      </div>

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <div className="absolute bottom-6 left-4 z-10 bg-white/90 backdrop-blur-sm
                      px-3 py-2 rounded-lg shadow text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
          Available
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-blue-500 inline-block" />
          On a Job
        </div>
      </div>

      {/* ── Map canvas ─────────────────────────────────────────────────── */}
      <Map
        ref={mapRef}
        mapboxAccessToken={mapboxToken}
        initialViewState={DEFAULT_VIEWPORT}
        style={{ width: '100%', height: '100%' }}
        mapStyle="mapbox://styles/mapbox/light-v11"
      >
        <NavigationControl position="top-right" />

        {/* ── Driver markers ────────────────────────────────────────────── */}
        {Array.from(drivers.values()).map((driver) => (
          <Marker
            key={driver.driverId}
            longitude={driver.lng}
            latitude={driver.lat}
            anchor="center"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              handleMarkerClick(driver);
            }}
          >
            <DriverMarkerIcon
              colour={markerColour(driver.driverId)}
              heading={driver.heading}
              isSelected={selectedDriver === driver.driverId}
            />
          </Marker>
        ))}

        {/* ── Selected driver popup ─────────────────────────────────────── */}
        {popupDriver && (
          <Popup
            longitude={popupDriver.lng}
            latitude={popupDriver.lat}
            anchor="bottom"
            onClose={closePopup}
            closeButton
            closeOnClick={false}
            className="text-sm"
          >
            <div className="min-w-[160px] p-1 space-y-1">
              <p className="font-semibold text-gray-800">Driver ID</p>
              <p className="font-mono text-xs text-gray-500 truncate">{popupDriver.driverId}</p>
              <div className="flex justify-between text-xs text-gray-600">
                <span>Status</span>
                <span
                  className={`font-medium ${
                    popupDriver.onlineStatus === 'AVAILABLE' ? 'text-green-600' : 'text-blue-600'
                  }`}
                >
                  {popupDriver.onlineStatus}
                </span>
              </div>
              {popupDriver.speedKmh !== undefined && (
                <div className="flex justify-between text-xs text-gray-600">
                  <span>Speed</span>
                  <span>{popupDriver.speedKmh.toFixed(1)} km/h</span>
                </div>
              )}
              {popupDriver.activeOrderId && (
                <div className="text-xs text-blue-700 mt-1 font-medium">
                  Order: {popupDriver.activeOrderId.slice(0, 8)}…
                </div>
              )}
              <p className="text-xs text-gray-400 mt-1">
                {new Date(popupDriver.timestamp).toLocaleTimeString()}
              </p>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}
