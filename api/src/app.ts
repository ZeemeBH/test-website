/**
 * @file app.ts
 * Express application factory.
 * Returns a configured app instance — does NOT start listening.
 * The HTTP server is created in server.ts so it can be shared with Socket.io.
 */

import 'reflect-metadata';
import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { getEnv } from './config/environment';
import { createRouter } from './routes/index';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { logger } from './utils/logger';
import type { DispatchEngine } from './services/dispatch/DispatchEngine';

export function createApp(db: DataSource, redis: Redis, dispatch: DispatchEngine): Application {
  const env = getEnv();
  const app = express();

  // ── Security headers ───────────────────────────────────────────────────────
  app.use(helmet());
  app.use(
    cors({
      origin: env.NODE_ENV === 'production' ? env.API_BASE_URL : '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    }),
  );

  // ── Parsing & compression ──────────────────────────────────────────────────
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(compression());

  // ── Request logging ────────────────────────────────────────────────────────
  if (env.NODE_ENV !== 'test') {
    app.use(
      morgan('combined', {
        stream: { write: (msg) => logger.info(msg.trim()) },
      }),
    );
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests — please try again later' },
    }),
  );

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.use(`/api/${env.API_VERSION}`, createRouter(db, redis, dispatch));

  // ── Error handlers (must be last) ─────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
