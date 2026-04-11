/**
 * @file LocationTracker.ts
 * Manages driver live-location data using Redis Geo commands.
 *
 * ── Strategy ──────────────────────────────────────────────────────────────
 *
 * 1. HIGH-FREQUENCY WRITES → REDIS ONLY
 *    Driver GPS pings arrive every 3-5 seconds.  Writing every ping directly
 *    to PostgreSQL would saturate the DB with ~10 writes/sec per driver.
 *    Instead we write to Redis using GEOADD under the key `active_drivers`
 *    (a sorted set with geohash scores).
 *
 * 2. TTL via EXPIREAT on a companion key
 *    Redis Geo sorted sets do not support per-member TTL.  We maintain a
 *    companion string key `driver:location:{id}` with an explicit EXPIRE.
 *    A background job (or Lua script) runs ZREM to evict stale members.
 *    The companion key is checked before dispatching — absent means offline.
 *
 * 3. PERIODIC POSTGRES FLUSH
 *    A 10-second debounced flush writes the latest location to the
 *    `drivers.current_location` PostGIS column.  This keeps the spatial
 *    index accurate for dispatch queries without per-ping DB writes.
 *
 * 4. BROADCAST THROTTLE
 *    The WebSocket handler calls `shouldBroadcast()` which implements a
 *    simple 1-second per-driver rate limit via a Redis SET with PX TTL.
 *    Excess pings are silently dropped to avoid flooding customers.
 */

import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { RedisKey } from '../../config/redis';
import { GeoService } from '../geo/GeoService';
import type { DriverLocationPayload, GeoPoint } from '../../types/interfaces';
import { logger } from '../../utils/logger';
import { getEnv } from '../../config/environment';

/** GCC bounding box — reject obviously invalid coordinates */
const GCC_BOUNDS = { minLat: 16, maxLat: 32, minLng: 42, maxLng: 60 };

export class LocationTracker {
  private readonly geoSetKey = 'active_drivers';
  private readonly broadcastThrottleMs = 1_000; // 1 s per driver
  private pendingFlush = new Map<string, GeoPoint>(); // driverId → latest point
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly db: DataSource,
    private readonly geo: GeoService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Processes an incoming GPS ping from a driver WebSocket connection.
   *
   * Steps:
   *  1. Validate coordinate range.
   *  2. GEOADD to the Redis geo sorted set.
   *  3. Refresh the companion key TTL.
   *  4. Schedule a debounced PostGIS flush.
   *
   * @returns true if the ping was accepted, false if coordinates are invalid
   */
  async handlePing(payload: DriverLocationPayload): Promise<boolean> {
    const { driverId, location, timestamp } = payload;
    const [lng, lat] = location.coordinates;

    if (!this.isValidCoordinate(lat, lng)) {
      logger.warn({ driverId, lat, lng }, '[LocationTracker] Invalid coordinates rejected');
      return false;
    }

    const env = getEnv();

    // Write to Redis Geo index
    await this.redis.geoadd(this.geoSetKey, lng, lat, driverId);

    // Companion key for TTL-based presence detection
    const companionKey = RedisKey.driverLocation(driverId);
    const locationData = JSON.stringify({ lat, lng, heading: payload.heading, speedKmh: payload.speedKmh, timestamp });
    await this.redis.set(companionKey, locationData, 'EX', env.REDIS_DRIVER_LOCATION_TTL);

    // Schedule debounced PostGIS flush (10 s batching window)
    this.pendingFlush.set(driverId, location);
    this.scheduleFlush();

    return true;
  }

  /**
   * Returns the last known location of a driver from Redis.
   * Returns null if the driver's location has expired (offline / ghost driver).
   */
  async getDriverLocation(driverId: string): Promise<DriverLocationPayload | null> {
    const raw = await this.redis.get(RedisKey.driverLocation(driverId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { lat: number; lng: number; heading?: number; speedKmh?: number; timestamp: number };
    return {
      driverId,
      location: { type: 'Point', coordinates: [parsed.lng, parsed.lat] },
      heading: parsed.heading,
      speedKmh: parsed.speedKmh,
      timestamp: parsed.timestamp,
    };
  }

  /**
   * Returns the IDs of all drivers within `radiusKm` of `origin`,
   * using Redis GEORADIUS (O(N+log(N)) on the geo sorted set).
   * This is a fast pre-filter before the authoritative PostGIS query.
   */
  async getNearbyDriverIds(origin: GeoPoint, radiusKm: number): Promise<string[]> {
    const [lng, lat] = origin.coordinates;
    // GEORADIUS is deprecated in Redis 6.2+; use GEOSEARCH instead
    const results = await this.redis.call(
      'GEOSEARCH',
      this.geoSetKey,
      'FROMLONLAT', lng, lat,
      'BYRADIUS', radiusKm, 'km',
      'ASC',
      'COUNT', 50,
    ) as string[];

    // Filter to only include drivers with a live companion key (not expired)
    const presenceChecks = await Promise.all(
      results.map(async (id) => ({
        id,
        alive: (await this.redis.exists(RedisKey.driverLocation(id))) === 1,
      })),
    );

    return presenceChecks.filter((d) => d.alive).map((d) => d.id);
  }

  /**
   * Marks a driver as online in the Redis sorted set (score = epoch ms).
   */
  async markDriverOnline(driverId: string): Promise<void> {
    await this.redis.zadd(RedisKey.driversOnline(), Date.now(), driverId);
  }

  /**
   * Removes a driver from the geo index and online set (graceful disconnect).
   */
  async markDriverOffline(driverId: string): Promise<void> {
    await Promise.all([
      this.redis.zrem(this.geoSetKey, driverId),
      this.redis.zrem(RedisKey.driversOnline(), driverId),
      this.redis.del(RedisKey.driverLocation(driverId)),
    ]);
    this.pendingFlush.delete(driverId);
  }

  /**
   * Rate-limit gate for WebSocket broadcasts.
   * Returns true (and sets a Redis lock) if this driver's location should
   * be forwarded to the customer room; false if we're within the throttle window.
   */
  async shouldBroadcast(driverId: string): Promise<boolean> {
    const key = `broadcast:throttle:${driverId}`;
    // NX = only set if not exists; PX = milliseconds TTL
    const result = await this.redis.set(key, '1', 'PX', this.broadcastThrottleMs, 'NX');
    return result === 'OK';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private isValidCoordinate(lat: number, lng: number): boolean {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    // Soft GCC bounds check — warn but still accept (drivers may be outside GCC)
    const inGcc =
      lat >= GCC_BOUNDS.minLat && lat <= GCC_BOUNDS.maxLat &&
      lng >= GCC_BOUNDS.minLng && lng <= GCC_BOUNDS.maxLng;
    if (!inGcc) {
      logger.debug({ lat, lng }, '[LocationTracker] Coordinates outside GCC bounds — accepted');
    }
    return true;
  }

  /**
   * Debounced PostGIS flush.
   * Collects all pending locations and writes them to PostgreSQL in a
   * single batched UPDATE … FROM (VALUES …) statement.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushToPostgres(), 10_000);
  }

  private async flushToPostgres(): Promise<void> {
    this.flushTimer = null;
    if (this.pendingFlush.size === 0) return;

    const batch = new Map(this.pendingFlush);
    this.pendingFlush.clear();

    const entries = Array.from(batch.entries());

    // Build a VALUES list: ($1, ST_GeographyFromText($2)), ($3, $4), ...
    const valuePlaceholders: string[] = [];
    const params: (string)[] = [];

    entries.forEach(([driverId, point], idx) => {
      const p1 = idx * 2 + 1;
      const p2 = idx * 2 + 2;
      valuePlaceholders.push(`($${p1}::uuid, ST_GeographyFromText($${p2}))`);
      params.push(driverId, GeoService.toWkt(point));
    });

    const sql = `
      UPDATE drivers AS d
      SET
        current_location     = v.location,
        last_location_update = NOW()
      FROM (VALUES ${valuePlaceholders.join(', ')}) AS v(id, location)
      WHERE d.id = v.id
    `;

    try {
      await this.db.query(sql, params);
      logger.debug({ count: entries.length }, '[LocationTracker] PostGIS flush complete');
    } catch (err) {
      logger.error({ err }, '[LocationTracker] PostGIS flush failed');
      // Re-queue failed entries for next flush
      entries.forEach(([id, pt]) => this.pendingFlush.set(id, pt));
      this.scheduleFlush();
    }
  }
}
