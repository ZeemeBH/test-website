/**
 * @file logger.ts
 * Structured logger using Pino.
 * In development LOG_PRETTY=true enables human-readable output.
 * In production emit JSON lines suitable for log aggregators (Datadog, etc.).
 */

import pino from 'pino';

// We access process.env directly here because the logger is initialised
// before environment.ts runs its full Zod parse.
const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true';

export const logger = pino({
  level,
  ...(isDev && pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  base: { service: 'pickup-dropoff-api' },
  redact: {
    // Never log these fields, even in development
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'body.password',
      'body.passwordHash',
      'body.bankDetails',
    ],
    censor: '[REDACTED]',
  },
});
