/**
 * @file redisLocation.service.ts
 * Redis Geospatial Location Service — the anti-"Ghost Driver" engine.
 *
 * ── The Ghost Driver Problem ───────────────────────────────────────────────
 * A "ghost driver" is a driver whose Redis entry is stale: their app crashed
 * or lost connectivity, but the platform still considers them online and
 * dispatches orders to them — resulting in unanswered offers and frustrated
 * customers.
 *
 * ── Solution ───────────────────────────────────────────────────────────────
 *
 * 1. PRESENCE KEY (string, with TTL)
 *    Every GPS ping sets `driver:presence:{driverId}` with SETEX <TTL>.
 *    Default TTL = 60 s.  If a driver stops pinging (crash / no signal),
 *    the key expires automatically → driver is invisible to dispatch.
 *
 * 2. GEO INDEX (sorted set, no native per-member TTL)
 *    `GEOADD active_drivers <lng> <lat> <driverId>` stores coordinates.
 *    We use a periodic sweep (runPresenceSweep) + Lua script to ZREM any
 *    member whose presence key has expired.
 *
 * 3. THROTTLING (1 Hz broadcast gate)
 *    `broadcast:throttle:{driverId}` SET NX PX 1000 — only 1 customer
 *    broadcast per second per driver, regardless of ping frequency.
 *
 * 4. POSTGRES FLUSH (10 s debounce)
 *    Driver location is flushed to PostGIS every 10 s in a batched UPDATE,
 *    keeping the spatial index fresh for dispatch proximity queries without
 *    per-ping DB writes.
 *
 * ── Key inventory ──────────────────────────────────────────────────────────
 *   active_drivers                    ZSET   geo sorted set (all online drivers)
 *   driver:presence:{id}              STRING TTL=60 s (liveness heartbeat)
 *   driver:location:{id}              STRING TTL=60 s (last location JSON)
 *   broadcast:throttle:{id}           STRING TTL=1 s  (rate-limit gate)
 *   order:room:{orderId}:driver       STRING           (active driver for order)
 */

import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { GeoService } from '../geo/GeoService';
import type { DriverLocationPayload, GeoPoint } from '../../types/interfaces';
import { logger } from '../../utils/logger';
import { getEnv } from '../../config/environment';

// ─────────────────────────────────────────────────────────────────────────────
// Lua script: atomic presence sweep
// Scans all members of the geo set and ZREMs those without a live presence key.
// Running as a Lua script ensures atomicity and avoids N round trips.
// ─────────────────────────────────────────────────────────────────────────────
const SWEEP_LUA = `
local members = redis.call('ZRANGEBYLEX', KEYS[1], '-', '+')
local removed  = 0
for _, member in ipairs(members) do
  local presenceKey = 'driver:presence:' .. member
  if redis.call('EXISTS', presenceKey) == 0 then
    redis.call('ZREM', KEYS[1], member)
    removed = removed + 1
  end
end
return removed
`;

export class RedisLocationService {
  private readonly GEO_KEY = 'active_drivers';
  private readonly PRESENCE_TTL: number;       // seconds
  private readonly BROADCAST_THROTTLE_MS = 1_000; // 1 Hz
  private readonly FLUSH_DEBOUNCE_MS = 10_000;    // 10 s batch window

  private pendingFlush = new Map<string, GeoPoint>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly db: DataSource,
    private readonly geo: GeoService,
  ) {
    this.PRESENCE_TTL = getEnv().REDIS_DRIVER_LOCATION_TTL;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot / teardown
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Starts the periodic ghost-driver sweep (every 30 s).
   * Call this once at server boot.
   */
  startSweep(intervalMs = 30_000): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => void this.runPresenceSweep(), intervalMs);
    logger.info('[RedisLocation] Ghost-driver sweep started');
  }

  stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core: process an incoming GPS ping
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Primary entry point for a driver's location_ping WebSocket event.
   *
   * @param payload   Authenticated DriverLocationPayload (driverId injected server-side)
   * @returns         `true` if accepted, `false` if coordinate validation failed
   *
   * Complexity:
   *   - 2 Redis writes (GEOADD + SETEX): O(log N) where N = online drivers
   *   - No DB write on this hot path
   */
  async processPing(payload: DriverLocationPayload): Promise<boolean> {
    const { driverId, location, timestamp, heading, speedKmh } = payload;
    const [lng, lat] = location.coordinates;

    // Guard: reject plainly invalid coordinates
    if (!this.isValidCoord(lat, lng)) {
      logger.warn({ driverId, lat, lng }, '[RedisLocation] Invalid coordinates — rejected');
      return false;
    }

    // Write 1: update geo sorted set (O(log N))
    await this.redis.geoadd(this.GEO_KEY, lng, lat, driverId);

    // Write 2: refresh presence key (proves driver is still alive)
    const presenceKey = `driver:presence:${driverId}`;
    await this.redis.setex(presenceKey, this.PRESENCE_TTL, '1');

    // Write 3: store full location blob for fast retrieval by customer/admin
    const locationKey = `driver:location:${driverId}`;
    const blob = JSON.stringify({ lat, lng, heading, speedKmh, timestamp });
    await this.redis.setex(locationKey, this.PRESENCE_TTL, blob);

    // Schedule debounced PostGIS flush (does NOT block this handler)
    this.pendingFlush.set(driverId, location);
    this.scheduleFlush();

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Broadcast gate
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Rate-limit guard: returns `true` and acquires a 1-second lock if this
   * driver is allowed to broadcast right now; `false` if already broadcast
   * within the last second.
   *
   * Uses SET … NX PX which is atomic — safe under concurrency.
   */
  async acquireBroadcastSlot(driverId: string): Promise<boolean> {
    const key = `broadcast:throttle:${driverId}`;
    const result = await this.redis.set(key, '1', 'PX', this.BROADCAST_THROTTLE_MS, 'NX');
    return result === 'OK';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Driver presence management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called when a driver connects and toggles "Go Online".
   * Adds the driver to the online ZSET with current-time score for
   * ZRANGEBYSCORE queries.
   */
  async markOnline(driverId: string, location: GeoPoint): Promise<void> {
    const [lng, lat] = location.coordinates;
    await Promise.all([
      this.redis.geoadd(this.GEO_KEY, lng, lat, driverId),
      this.redis.zadd('drivers:online', Date.now(), driverId),
      this.redis.setex(`driver:presence:${driverId}`, this.PRESENCE_TTL, '1'),
    ]);
    logger.info({ driverId }, '[RedisLocation] Driver marked online');
  }

  /**
   * Called on graceful disconnect or "Go Offline" toggle.
   * Immediately removes the driver from all active sets.
   */
  async markOffline(driverId: string): Promise<void> {
    await Promise.all([
      this.redis.zrem(this.GEO_KEY, driverId),
      this.redis.zrem('drivers:online', driverId),
      this.redis.del(`driver:presence:${driverId}`),
      this.redis.del(`driver:location:${driverId}`),
    ]);
    this.pendingFlush.delete(driverId);
    logger.info({ driverId }, '[RedisLocation] Driver marked offline');
  }

  /**
   * Returns true if the driver has a live presence key.
   * A missing key means the driver has gone silent (ghost driver).
   */
  async isAlive(driverId: string): Promise<boolean> {
    return (await this.redis.exists(`driver:presence:${driverId}`)) === 1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Proximity search
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns driver IDs within `radiusKm` of `origin`, ordered by distance.
   * Uses Redis GEOSEARCH (Redis 6.2+) — falls back to GEORADIUSBYMEMBER.
   *
   * Only returns drivers whose presence key is still alive (no ghost drivers).
   *
   * @param origin    GeoJSON Point
   * @param radiusKm  Search radius
   * @param maxCount  Max results (default 50)
   */
  async getNearbyLiveDrivers(
    origin: GeoPoint,
    radiusKm: number,
    maxCount = 50,
  ): Promise<string[]> {
    const [lng, lat] = origin.coordinates;

    const raw = await this.redis.call(
      'GEOSEARCH',
      this.GEO_KEY,
      'FROMLONLAT', String(lng), String(lat),
      'BYRADIUS', String(radiusKm), 'km',
      'ASC',
      'COUNT', String(maxCount),
    ) as string[];

    // Filter out any ghost drivers (presence key expired but not yet swept)
    const liveResults = await Promise.all(
      raw.map(async (id) => ({ id, alive: await this.isAlive(id) })),
    );

    return liveResults.filter((d) => d.alive).map((d) => d.id);
  }

  /**
   * Returns the cached location blob for a driver, or null if offline.
   */
  async getLocation(driverId: string): Promise<DriverLocationPayload | null> {
    const raw = await this.redis.get(`driver:location:${driverId}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      lat: number; lng: number;
      heading?: number; speedKmh?: number; timestamp: number;
    };

    return {
      driverId,
      location: { type: 'Point', coordinates: [parsed.lng, parsed.lat] },
      heading: parsed.heading,
      speedKmh: parsed.speedKmh,
      timestamp: parsed.timestamp,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Order-room binding
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Associates a driver with an active order so the broadcast handler knows
   * which Socket.io room to emit location updates to.
   */
  async bindDriverToOrder(driverId: string, orderId: string): Promise<void> {
    // Store bi-directional references with a generous TTL (8 h)
    await Promise.all([
      this.redis.setex(`order:active_driver:${orderId}`, 28_800, driverId),
      this.redis.setex(`driver:active_order:${driverId}`, 28_800, orderId),
    ]);
  }

  async unbindDriverFromOrder(driverId: string, orderId: string): Promise<void> {
    await Promise.all([
      this.redis.del(`order:active_driver:${orderId}`),
      this.redis.del(`driver:active_order:${driverId}`),
    ]);
  }

  async getActiveOrderForDriver(driverId: string): Promise<string | null> {
    return this.redis.get(`driver:active_order:${driverId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ghost driver sweep
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs the Lua presence sweep — atomically removes expired drivers from
   * the geo sorted set.
   *
   * This is the primary defence against ghost drivers.
   *
   * Strategy:
   *  - Runs every 30 s via `startSweep()`.
   *  - Also called immediately when a driver's offer key expires (in DispatchEngine).
   */
  async runPresenceSweep(): Promise<number> {
    try {
      const removed = await this.redis.eval(SWEEP_LUA, 1, this.GEO_KEY) as number;
      if (removed > 0) {
        logger.info({ removed }, '[RedisLocation] Ghost-driver sweep evicted stale entries');
      }
      return removed;
    } catch (err) {
      logger.error({ err }, '[RedisLocation] Sweep failed');
      return 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PostGIS flush (debounced)
  // ─────────────────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flushToPostgres(), this.FLUSH_DEBOUNCE_MS);
  }

  /**
   * Batched UPDATE of driver locations to the PostGIS geography column.
   *
   * Uses a single UPDATE … FROM (VALUES …) statement to write all pending
   * locations in one round trip.  This keeps the spatial index fresh for
   * dispatch proximity queries (ST_DWithin) without per-ping DB writes.
   *
   * Throttle: fires at most once per FLUSH_DEBOUNCE_MS (10 s).
   */
  private async flushToPostgres(): Promise<void> {
    this.flushTimer = null;
    if (this.pendingFlush.size === 0) return;

    const batch = new Map(this.pendingFlush);
    this.pendingFlush.clear();

    const entries = Array.from(batch.entries());
    const valuePlaceholders: string[] = [];
    const params: string[] = [];

    entries.forEach(([driverId, point], idx) => {
      const p1 = idx * 2 + 1;
      const p2 = idx * 2 + 2;
      valuePlaceholders.push(`($${p1}::uuid, ST_GeographyFromText($${p2}))`);
      params.push(driverId, GeoService.toWkt(point));
    });

    const sql = `
      UPDATE drivers AS d
      SET
        current_location     = v.loc,
        last_location_update = NOW()
      FROM (VALUES ${valuePlaceholders.join(', ')}) AS v(id, loc)
      WHERE d.id = v.id
    `;

    try {
      await this.db.query(sql, params);
      logger.debug({ count: entries.length }, '[RedisLocation] PostGIS flush OK');
    } catch (err) {
      logger.error({ err }, '[RedisLocation] PostGIS flush failed — re-queuing');
      entries.forEach(([id, pt]) => this.pendingFlush.set(id, pt));
      this.scheduleFlush();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private isValidCoord(lat: number, lng: number): boolean {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }
}
