/**
 * @file auth.middleware.ts
 * JWT-based authentication and role-based authorisation middleware.
 *
 * Flow:
 *  1. Extract Bearer token from the Authorization header.
 *  2. Verify signature using JWT_ACCESS_SECRET.
 *  3. Check token hasn't expired (handled by jsonwebtoken).
 *  4. Attach decoded payload to req.user for downstream handlers.
 *
 * The `requireRole(...roles)` factory produces a guard that checks
 * req.user.role against an allowed list.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/environment';
import type { JwtAccessPayload, AuthenticatedUser } from '../types/interfaces';
import { logger } from '../utils/logger';

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, getEnv().JWT_ACCESS_SECRET) as JwtAccessPayload;

    req.user = {
      id: payload.sub,
      role: payload.role,
    } satisfies AuthenticatedUser;

    next();
  } catch (err) {
    const isExpired = err instanceof jwt.TokenExpiredError;
    logger.debug({ err }, '[Auth] Token verification failed');
    res.status(401).json({
      success: false,
      message: isExpired ? 'Access token expired' : 'Invalid access token',
    });
  }
}

/**
 * Role guard — must be used AFTER `authenticate`.
 *
 * @example
 *   router.get('/admin', authenticate, requireRole('ADMIN'), handler)
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthenticated' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: `Access denied. Required role(s): ${roles.join(', ')}`,
      });
      return;
    }

    next();
  };
}

/**
 * Convenience guard: only drivers may call the decorated route.
 */
export const requireDriver = requireRole('DRIVER');

/**
 * Convenience guard: only admins may call the decorated route.
 */
export const requireAdmin = requireRole('ADMIN');
