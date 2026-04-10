/**
 * @file LocationService.ts
 * Background GPS location service for the Driver App.
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 *
 * Expo Location provides two modes:
 *   FOREGROUND: Works while the app is in the foreground.
 *   BACKGROUND: Continues when the app is backgrounded (requires a
 *               background task registered with expo-task-manager).
 *
 * We use a hybrid approach:
 *   - FOREGROUND subscription (`watchPositionAsync`) provides high-accuracy
 *     GPS and emits every 3 s while the app is active.
 *   - BACKGROUND task (`startLocationUpdatesAsync`) fires every 5 s in the
 *     background with slightly lower accuracy for battery efficiency.
 *   - Both paths emit `location_ping` via the Socket.io connection.
 *
 * ── Battery optimisation ──────────────────────────────────────────────────
 *
 * 1. Foreground: `accuracy: Best, timeInterval: 3000, distanceInterval: 10`
 *    Only fires if the driver has moved ≥10 m OR 3 s have elapsed.
 *    Prevents redundant pings when stationary.
 *
 * 2. Background: `accuracy: Balanced, timeInterval: 5000, distanceInterval: 20`
 *    `Balanced` uses cell/WiFi-assisted location instead of pure GPS,
 *    consuming significantly less battery.
 *
 * 3. The server-side throttle (1 Hz broadcast gate) provides an additional
 *    layer of rate limiting so even if pings arrive faster, the customer
 *    screen is never flooded.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   const svc = new LocationService(socket);
 *   await svc.start();   // call when driver taps "Go Online"
 *   await svc.stop();    // call when driver taps "Go Offline"
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { Socket } from 'socket.io-client';
import { AppState, type AppStateStatus } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BACKGROUND_TASK = 'driver-location-task';

const FOREGROUND_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  timeInterval: 3_000,   // ms — at most 1 ping every 3 s
  distanceInterval: 10,  // m  — only if moved ≥10 m
};

const BACKGROUND_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 5_000,
  distanceInterval: 20,
  showsBackgroundLocationIndicator: true,    // iOS blue status bar pill
  pausesUpdatesAutomatically: false,
  activityType: Location.ActivityType.AutomotiveNavigation,
};

// ─────────────────────────────────────────────────────────────────────────────
// Background task registration
// IMPORTANT: TaskManager.defineTask must be called at the TOP LEVEL of a
// module (not inside a function or class), before any task is started.
// It is idempotent — safe to call multiple times.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The background task receives location updates from the OS and emits them
 * via the singleton socket connection stored in LocationService.sharedSocket.
 */
TaskManager.defineTask(BACKGROUND_TASK, ({ data, error }: TaskManager.TaskManagerTaskBody<{ locations: Location.LocationObject[] }>) => {
  if (error) {
    console.error('[LocationService][BG] Task error:', error.message);
    return;
  }

  const socket = LocationService.sharedSocket;
  if (!socket?.connected) return;

  const locations = data?.locations ?? [];
  const latest = locations[locations.length - 1];
  if (!latest) return;

  socket.emit('location_ping', {
    lat: latest.coords.latitude,
    lng: latest.coords.longitude,
    heading: latest.coords.heading ?? undefined,
    speed: latest.coords.speed !== null && latest.coords.speed >= 0
      ? latest.coords.speed * 3.6  // m/s → km/h
      : undefined,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LocationService class
// ─────────────────────────────────────────────────────────────────────────────

export class LocationService {
  /** Shared socket reference used by the background task (module-level) */
  static sharedSocket: Socket | null = null;

  private foregroundSubscription: Location.LocationSubscription | null = null;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private isRunning = false;

  constructor(private readonly socket: Socket) {
    LocationService.sharedSocket = socket;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Requests permissions and starts both foreground + background location.
   * Call this when the driver taps "Go Online".
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // ── Permission check ────────────────────────────────────────────────────
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') {
      throw new Error('Foreground location permission denied');
    }

    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    if (bg !== 'granted') {
      console.warn('[LocationService] Background permission denied — foreground only');
    }

    // ── Start foreground subscription ───────────────────────────────────────
    this.foregroundSubscription = await Location.watchPositionAsync(
      FOREGROUND_OPTIONS,
      (location) => this.handleForegroundUpdate(location),
    );

    // ── Start background task (if permission granted) ───────────────────────
    if (bg === 'granted') {
      const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK);
      if (!alreadyStarted) {
        await Location.startLocationUpdatesAsync(BACKGROUND_TASK, BACKGROUND_OPTIONS);
      }
    }

    // ── Listen for app state transitions ───────────────────────────────────
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppState);

    this.isRunning = true;
    console.info('[LocationService] Started');
  }

  /**
   * Stops all location subscriptions.
   * Call this when the driver taps "Go Offline" or closes the app.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.foregroundSubscription?.remove();
    this.foregroundSubscription = null;

    this.appStateSubscription?.remove();
    this.appStateSubscription = null;

    try {
      const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK);
      if (running) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
      }
    } catch {
      // Non-fatal — background task may not have started
    }

    LocationService.sharedSocket = null;
    this.isRunning = false;
    console.info('[LocationService] Stopped');
  }

  get running(): boolean {
    return this.isRunning;
  }

  // ── Private handlers ──────────────────────────────────────────────────────

  private handleForegroundUpdate(location: Location.LocationObject): void {
    if (!this.socket.connected) return;

    this.socket.emit('location_ping', {
      lat: location.coords.latitude,
      lng: location.coords.longitude,
      heading: location.coords.heading ?? undefined,
      speed: location.coords.speed !== null && location.coords.speed >= 0
        ? location.coords.speed * 3.6
        : undefined,
    });
  }

  /**
   * When the app transitions to the background, the foreground subscription
   * is paused by the OS.  We rely on the background task from this point.
   * When it returns to foreground, resume the foreground subscription.
   */
  private handleAppState = (nextState: AppStateStatus): void => {
    if (nextState === 'active') {
      // Resumed — foreground subscription is automatically active again
      console.debug('[LocationService] Foreground resumed');
    } else if (nextState === 'background') {
      console.debug('[LocationService] Backgrounded — BG task takes over');
    }
  };
}
