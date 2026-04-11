/**
 * @file server.ts
 * Application entry point.
 *
 * Boot sequence:
 *  1. Validate environment variables.
 *  2. Connect to PostgreSQL (TypeORM) and run pending migrations.
 *  3. Connect to Redis.
 *  4. Build Express app.
 *  5. Create HTTP server and attach Socket.io.
 *  6. Instantiate services that depend on live connections.
 *  7. Start listening.
 *  8. Register graceful shutdown handlers.
 */

import 'reflect-metadata';
import { createServer } from 'http';
import { getEnv } from './config/environment';
import { getDataSource } from './config/database';
import { getRedisClient } from './config/redis';
import { createApp } from './app';
import { SocketManager } from './socket/SocketManager';
import { GeoService } from './services/geo/GeoService';
import { LocationTracker } from './services/location/LocationTracker';
import { DispatchEngine } from './services/dispatch/DispatchEngine';
import { PricingEngine } from './services/pricing/PricingEngine';
import { logger } from './utils/logger';

async function bootstrap(): Promise<void> {
  // ── 1. Environment ─────────────────────────────────────────────────────────
  const env = getEnv(); // throws on invalid config

  // ── 2. Database ────────────────────────────────────────────────────────────
  logger.info('[Boot] Connecting to PostgreSQL…');
  const db = await getDataSource();
  logger.info('[Boot] PostgreSQL connected');

  // Run pending migrations automatically
  const pending = await db.showMigrations();
  if (pending) {
    logger.info('[Boot] Running pending migrations…');
    await db.runMigrations({ transaction: 'each' });
    logger.info('[Boot] Migrations complete');
  }

  // ── 3. Redis ───────────────────────────────────────────────────────────────
  logger.info('[Boot] Connecting to Redis…');
  const redis = getRedisClient();
  await redis.ping(); // will throw if connection fails
  logger.info('[Boot] Redis connected');

  // ── 4. Services ────────────────────────────────────────────────────────────
  const geo = new GeoService(db);
  const locationTracker = new LocationTracker(redis, db, geo);
  const pricing = new PricingEngine();

  // Placeholder SocketManager — will be wired after HTTP server creation
  let socketManager!: SocketManager;

  // DispatchEngine needs SocketManager — we'll inject it after construction
  const dispatchEngine = new DispatchEngine(
    db,
    redis,
    geo,
    locationTracker,
    // This is a forward reference; SocketManager is assigned below
    new Proxy({} as SocketManager, {
      get(_t, prop) {
        return (...args: unknown[]) =>
          (socketManager[prop as keyof SocketManager] as (...a: unknown[]) => unknown)(...args);
      },
    }),
  );

  // ── 5. Express & HTTP server ───────────────────────────────────────────────
  const app = createApp(db, redis, dispatchEngine);
  const httpServer = createServer(app);

  // ── 6. Socket.io ───────────────────────────────────────────────────────────
  socketManager = new SocketManager(httpServer);
  logger.info('[Boot] Socket.io attached');

  // Wire driver WebSocket handlers into the Socket.io connection event
  socketManager.io.on('connection', (socket) => {
    const userId = (socket as unknown as { userId: string }).userId;
    const role = (socket as unknown as { userRole: string }).userRole;

    if (role === 'DRIVER') {
      // Driver ID is their userId in this implementation
      // (separate driver accounts link via userId FK)
      const { registerDriverHandlers } = require('./socket/handlers/driver.handler');
      registerDriverHandlers(socket, userId, locationTracker, socketManager, redis, db);
    }
  });

  // ── 7. Listen ──────────────────────────────────────────────────────────────
  httpServer.listen(env.PORT, () => {
    logger.info(
      `[Boot] Server running on port ${env.PORT} (${env.NODE_ENV}) — API: /api/${env.API_VERSION}`,
    );
  });

  // ── 8. Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`[Shutdown] ${signal} received`);

    httpServer.close(async () => {
      logger.info('[Shutdown] HTTP server closed');
      try {
        await db.destroy();
        logger.info('[Shutdown] DB connection closed');
        redis.disconnect();
        logger.info('[Shutdown] Redis disconnected');
      } catch (err) {
        logger.error({ err }, '[Shutdown] Error during cleanup');
      }
      process.exit(0);
    });

    // Force exit after 15 s if graceful shutdown hangs
    setTimeout(() => {
      logger.error('[Shutdown] Forced exit after timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '[Boot] Uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, '[Boot] Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[Boot] Fatal startup error:', err);
  process.exit(1);
});
