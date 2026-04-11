/**
 * @file error.middleware.ts
 * Centralised Express error handler.
 *
 * All thrown errors (or next(err) calls) end up here.
 * Produces a consistent JSON envelope and never leaks stack traces in production.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { getEnv } from '../config/environment';

/** Base class for intentional API errors. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errors?: string[],
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(errors: string[]) {
    super(400, 'Validation failed', errors);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
    this.name = 'ConflictError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express error handler (4-param signature required by Express)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const isProd = getEnv().NODE_ENV === 'production';

  if (err instanceof AppError) {
    logger.warn({ err, path: req.path, method: req.method }, err.message);
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
    });
    return;
  }

  // Unexpected error — log full stack, return generic 500
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(isProd ? {} : { debug: err.message, stack: err.stack }),
  });
}

/** 404 catch-all — register AFTER all routes */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
}
