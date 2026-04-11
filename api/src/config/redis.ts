/**
 * @file redis.ts
 * Provides a singleton ioredis client.
 *
 * Redis is used for:
 *  1. Driver live-location cache  — KEY: driver:location:{driverId}
 *     VALUE: JSON { lat, lng, heading, speedKmh, timestamp }
 *     TTL: REDIS_DRIVER_LOCATION_TTL seconds (default 30 s)
 *
 *  2. Dispatch lock              — KEY: dispatch:lock:{orderId}
 *     Ensures only one dispatch loop runs per order.
 *     TTL: DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS / 1000 * retries
 *
 *  3. Driver order offer         — KEY: dispatch:offer:{orderId}:{driverId}
 *     TTL: DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS / 1000
 *
 *  4. Online driver set          — KEY: drivers:online
 *     ZADD with score = last heartbeat epoch. Allows ZRANGEBYSCORE queries.
 */

import Redis from 'ioredis';
import { getEnv } from './environment';
import { logger } from '../utils/logger';

let _client: Redis | null = null;

export function getRedisClient(): Redis {
  if (_client) return _client;

  const env = getEnv();

  _client = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    db: env.REDIS_DB,
    // Reconnect with exponential back-off, max 10 s
    retryStrategy: (times: number) => Math.min(times * 200, 10_000),
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
  });

  _client.on('connect', () => logger.info('[Redis] Connected'));
  _client.on('ready', () => logger.info('[Redis] Ready'));
  _client.on('error', (err) => logger.error({ err }, '[Redis] Error'));
  _client.on('close', () => logger.warn('[Redis] Connection closed'));
  _client.on('reconnecting', (delay: number) =>
    logger.warn(`[Redis] Reconnecting in ${delay} ms`),
  );

  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis key factories (single source of truth for key names)
// ─────────────────────────────────────────────────────────────────────────────

export const RedisKey = {
  driverLocation: (driverId: string) => `driver:location:${driverId}`,
  driversOnline: () => `drivers:online`,
  dispatchLock: (orderId: string) => `dispatch:lock:${orderId}`,
  dispatchOffer: (orderId: string, driverId: string) =>
    `dispatch:offer:${orderId}:${driverId}`,
  orderChannel: (orderId: string) => `order:channel:${orderId}`,
  driverChannel: (driverId: string) => `driver:channel:${driverId}`,
} as const;
