/**
 * @file driverAuth.routes.ts
 * Mounts driver authentication and onboarding endpoints.
 *
 * Public routes:
 *   POST /driver/auth/register        — create account + send OTP
 *   POST /driver/auth/verify-phone    — confirm OTP → receive tokens
 *   POST /driver/auth/request-otp     — request OTP for OTP-login
 *   POST /driver/auth/login-otp       — OTP-based login
 *   POST /driver/auth/login           — email/password login
 *   POST /driver/auth/refresh         — rotate access token
 *
 * Protected routes:
 *   POST /driver/auth/logout          — requireAuth (any authenticated driver)
 */

import { Router } from 'express';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createDriverAuthController } from '../controllers/driverAuth.controller';
import { requireAuth } from '../middleware/requireAuth.middleware';

export function createDriverAuthRouter(db: DataSource, redis: Redis): Router {
  const router = Router();
  const ctrl = createDriverAuthController(db, redis);

  // Two-step registration
  router.post('/register',      ...ctrl.register);
  router.post('/verify-phone',  ...ctrl.verifyPhone);

  // OTP login
  router.post('/request-otp',  ...ctrl.requestOtp);
  router.post('/login-otp',    ...ctrl.loginWithOtp);

  // Password login
  router.post('/login',        ...ctrl.loginWithPassword);

  // Token management
  router.post('/refresh',      ...ctrl.refresh);
  router.post('/logout',       requireAuth, ctrl.logout);

  return router;
}
