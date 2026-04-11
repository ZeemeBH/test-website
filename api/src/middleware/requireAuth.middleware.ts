/**
 * @file requireAuth.middleware.ts
 * Enterprise-grade JWT authentication & RBAC middleware.
 *
 * ── How it works ──────────────────────────────────────────────────────────
 *
 * 1. Extract the Bearer token from the Authorization header.
 * 2. Verify signature with JWT_ACCESS_SECRET (asymmetric option: swap in
 *    RS256 public key in production if you rotate keys with a key management
 *    service).
 * 3. Check token hasn't been revoked via the user's refreshTokenFamily
 *    (optional DB check for high-security endpoints — see `strictAuth`).
 * 4. Attach the decoded payload to req.user.
 * 5. Role guards (`requireRole`, `requireDriver`, `requireAdmin`) check
 *    req.user.role against an allow-list.
 *
 * ── RBAC Role Hierarchy ───────────────────────────────────────────────────
 *
 *   ADMIN    — full access to all endpoints including dispatch override
 *   SUPPORT  — read-only access to orders and users; no financial actions
 *   DRIVER   — driver lifecycle endpoints only; cannot access customer data
 *   CUSTOMER — own orders, payments, and profile only
 *
 * ── Token types ───────────────────────────────────────────────────────────
 *
 *   Access token  : 15 min, signed HS256, verified on every request.
 *   Refresh token : 7 days, signed with a different secret, used only on
 *                   POST /auth/refresh to issue a new access token.
 *                   Stored nowhere server-side — stateless, but rotated
 *                   via the token family mechanism.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/environment';
import type { JwtAccessPayload, AuthenticatedUser } from '../types/interfaces';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Core authentication middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `requireAuth` — verifies the JWT access token and populates req.user.
 *
 * Usage:
 *   router.get('/me', requireAuth, handler)
 */
export const requireAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      code: 'AUTH_MISSING',
      message: 'Authorization header required (Bearer <token>)',
    });
    return;
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, getEnv().JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    }) as JwtAccessPayload;

    req.user = {
      id: payload.sub,
      role: payload.role,
    } satisfies AuthenticatedUser;

    next();
  } catch (err) {
    const isExpired = err instanceof jwt.TokenExpiredError;
    logger.debug({ err }, '[requireAuth] Token rejected');

    res.status(401).json({
      success: false,
      code: isExpired ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
      message: isExpired
        ? 'Access token expired. Use /auth/refresh to get a new one.'
        : 'Invalid access token.',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Role guards (must be used AFTER requireAuth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a middleware that allows ONLY the specified roles.
 *
 * @example
 *   router.delete('/users/:id', requireAuth, requireRole('ADMIN'), handler)
 *   router.post('/orders', requireAuth, requireRole('CUSTOMER', 'ADMIN'), handler)
 */
export function requireRole(...allowedRoles: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, code: 'AUTH_MISSING', message: 'Unauthenticated' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(
        { userId: req.user.id, role: req.user.role, required: allowedRoles, path: req.path },
        '[RBAC] Access denied',
      );
      res.status(403).json({
        success: false,
        code: 'RBAC_DENIED',
        message: `Access denied. Required role(s): ${allowedRoles.join(' | ')}`,
      });
      return;
    }

    next();
  };
}

// ── Convenience guards ────────────────────────────────────────────────────────

/** Only drivers may call the decorated route */
export const requireDriver: RequestHandler = requireRole('DRIVER');

/** Only admins may call the decorated route */
export const requireAdmin: RequestHandler = requireRole('ADMIN');

/** Only support staff or admins */
export const requireSupport: RequestHandler = requireRole('SUPPORT', 'ADMIN');

/** Customers or admins (prevents driver accessing customer endpoints) */
export const requireCustomer: RequestHandler = requireRole('CUSTOMER', 'ADMIN');

// ─────────────────────────────────────────────────────────────────────────────
// Ownership guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures the authenticated user is accessing their own resource.
 * Admins bypass this check.
 *
 * @param getResourceOwnerId  Function that extracts the owner's userId from
 *                            the request (usually req.params.userId or a DB lookup)
 *
 * @example
 *   router.get('/users/:userId/profile',
 *     requireAuth,
 *     requireOwnership((req) => req.params.userId),
 *     handler
 *   )
 */
export function requireOwnership(
  getResourceOwnerId: (req: Request) => string | Promise<string>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthenticated' });
      return;
    }

    // Admins may access any resource
    if (req.user.role === 'ADMIN') {
      next();
      return;
    }

    try {
      const ownerId = await getResourceOwnerId(req);

      if (req.user.id !== ownerId) {
        res.status(403).json({
          success: false,
          code: 'OWNERSHIP_DENIED',
          message: 'You do not have permission to access this resource',
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
