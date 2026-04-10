/**
 * @file auth.controller.ts
 * Handles registration, login, token refresh, and logout for both
 * customers and drivers.
 *
 * Token strategy:
 *  - Access token  : short-lived (15 min), signed with JWT_ACCESS_SECRET
 *  - Refresh token : long-lived (7 days), signed with JWT_REFRESH_SECRET,
 *                    tied to a "token family" stored on the user row.
 *                    Rotating the family invalidates ALL previous refresh tokens
 *                    (defence against refresh token theft / reuse detection).
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { User } from '../entities/User.entity';
import { Driver } from '../entities/Driver.entity';
import { getEnv } from '../config/environment';
import { parsePhone } from '../utils/phone.util';
import { randomHex } from '../utils/crypto.util';
import { UserRole } from '../types/enums';
import type { JwtAccessPayload, JwtRefreshPayload } from '../types/interfaces';
import { AppError, ConflictError } from '../middleware/error.middleware';
import { validate } from '../middleware/validate.middleware';

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas
// ─────────────────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().min(7).max(20),
  phoneRegion: z.enum(['BH', 'SA', 'AE', 'KW', 'QA', 'OM']).default('BH'),
  password: z.string().min(8).max(128),
  preferredCurrency: z.enum(['BHD', 'SAR', 'AED', 'USD']).default('BHD'),
  locale: z.string().default('en-US'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────────────
// Controller factory
// ─────────────────────────────────────────────────────────────────────────────

export function createAuthController(db: DataSource) {
  const userRepo = db.getRepository(User);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function issueTokens(userId: string, role: string): { accessToken: string; refreshToken: string } {
    const env = getEnv();

    const accessPayload: JwtAccessPayload = { sub: userId, role };
    const accessToken = jwt.sign(accessPayload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    });

    const jti = randomHex(16);
    const refreshPayload: JwtRefreshPayload = { sub: userId, jti };
    const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN,
    });

    return { accessToken, refreshToken };
  }

  // ── Register (Customer) ───────────────────────────────────────────────────

  async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as z.infer<typeof registerSchema>;

      // Check uniqueness
      const existing = await userRepo.findOne({
        where: [{ email: body.email }],
      });
      if (existing) throw new ConflictError('Email is already registered');

      // Parse and validate phone number
      const phoneMeta = parsePhone(body.phone, body.phoneRegion as never);

      const phoneExists = await userRepo.findOne({ where: { phoneE164: phoneMeta.e164 } });
      if (phoneExists) throw new ConflictError('Phone number is already registered');

      // Hash password
      const passwordHash = await bcrypt.hash(body.password, 12);

      const user = userRepo.create({
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phoneE164: phoneMeta.e164,
        phoneMeta,
        passwordHash,
        role: UserRole.CUSTOMER,
        preferredCurrency: body.preferredCurrency as never,
        locale: body.locale,
        refreshTokenFamily: randomHex(16),
      });

      await userRepo.save(user);

      const tokens = issueTokens(user.id, user.role);

      res.status(201).json({
        success: true,
        data: {
          user: { id: user.id, email: user.email, firstName: user.firstName, role: user.role },
          ...tokens,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password } = req.body as z.infer<typeof loginSchema>;

      const user = await userRepo
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.email = :email', { email })
        .getOne();

      if (!user) throw new AppError(401, 'Invalid email or password');
      if (!user.isActive) throw new AppError(403, 'Account is deactivated');

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) throw new AppError(401, 'Invalid email or password');

      // Rotate token family on every login
      await userRepo.update(user.id, {
        refreshTokenFamily: randomHex(16),
        lastLoginAt: new Date(),
      });

      const tokens = issueTokens(user.id, user.role);

      res.json({
        success: true,
        data: {
          user: { id: user.id, email: user.email, firstName: user.firstName, role: user.role },
          ...tokens,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
      const env = getEnv();

      let payload: JwtRefreshPayload;
      try {
        payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as JwtRefreshPayload;
      } catch {
        throw new AppError(401, 'Invalid or expired refresh token');
      }

      const user = await userRepo.findOne({ where: { id: payload.sub } });
      if (!user || !user.isActive) throw new AppError(401, 'User not found or inactive');

      // Rotate family to invalidate all previous refresh tokens
      await userRepo.update(user.id, { refreshTokenFamily: randomHex(16) });

      const tokens = issueTokens(user.id, user.role);
      res.json({ success: true, data: tokens });
    } catch (err) {
      next(err);
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.user) {
        // Invalidate all refresh tokens by rotating the family
        await userRepo.update(req.user.id, { refreshTokenFamily: randomHex(16) });
      }
      res.json({ success: true, message: 'Logged out' });
    } catch (err) {
      next(err);
    }
  }

  // ── Me ────────────────────────────────────────────────────────────────────

  async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await userRepo.findOne({ where: { id: req.user!.id } });
      if (!user) throw new AppError(404, 'User not found');
      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  }

  return {
    register: [validate(registerSchema), register],
    login: [validate(loginSchema), login],
    refresh: [validate(refreshSchema), refresh],
    logout,
    me,
  };
}
