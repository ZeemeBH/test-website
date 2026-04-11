/**
 * @file otp.service.ts
 * One-Time Password generation, storage, and verification.
 *
 * ── Design ────────────────────────────────────────────────────────────────
 *
 * OTPs are 6-digit numeric codes (000000–999999) generated via
 * crypto.randomInt() — cryptographically secure, uniform distribution.
 *
 * Storage: Redis, not PostgreSQL.
 *   KEY :  otp:{phoneE164}
 *   VALUE: bcrypt hash of the code (prevents cache poisoning if Redis is
 *          compromised — an attacker with Redis read access cannot derive
 *          the plaintext OTP from the stored hash)
 *   TTL :  OTP_TTL_SECONDS (default 300 s / 5 min)
 *
 * Rate limiting:
 *   KEY :  otp:rate:{phoneE164}
 *   VALUE: counter (incr)
 *   TTL :  OTP_RATE_WINDOW_SECONDS (default 3600 s / 1 h)
 *   Limit: MAX_OTP_REQUESTS_PER_HOUR (default 5)
 *
 * Attempt limiting:
 *   KEY :  otp:attempts:{phoneE164}
 *   VALUE: counter (incr)
 *   TTL :  OTP_TTL_SECONDS
 *   Limit: MAX_OTP_ATTEMPTS (default 3) — code is invalidated after 3 wrong guesses
 *
 * ── GCC region validation ─────────────────────────────────────────────────
 *
 * Phone numbers are strictly validated with libphonenumber-js and only
 * accepted for the following regions:
 *   BH +973  Bahrain
 *   SA +966  Saudi Arabia
 *   AE +971  UAE
 *   KW +965  Kuwait
 *   QA +974  Qatar
 *   OM +968  Oman
 */

import { randomInt } from 'crypto';
import bcrypt from 'bcryptjs';
import type Redis from 'ioredis';
import { parsePhone, isValidPhone } from '../../utils/phone.util';
import type { ParsedPhoneNumber } from '../../types/interfaces';
import { AppError } from '../../middleware/error.middleware';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Regions accepted for OTP verification. */
export const SUPPORTED_OTP_REGIONS = ['BH', 'SA', 'AE', 'KW', 'QA', 'OM'] as const;
export type SupportedOtpRegion = typeof SUPPORTED_OTP_REGIONS[number];

const OTP_TTL_SECONDS = 300;          // 5 minutes
const OTP_RATE_WINDOW_SECONDS = 3600; // 1 hour window
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const MAX_OTP_ATTEMPTS = 3;
const BCRYPT_ROUNDS = 10;             // Low rounds acceptable — OTP is short-lived

// ─────────────────────────────────────────────────────────────────────────────
// OTP Service
// ─────────────────────────────────────────────────────────────────────────────

export class OtpService {
  constructor(private readonly redis: Redis) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Phone validation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parses and validates a raw phone string for a GCC region.
   * Throws a 400 AppError if the number is invalid or the region is unsupported.
   *
   * @param raw     User-supplied phone string (may include or omit country code)
   * @param region  ISO 3166-1 alpha-2, e.g. 'BH', 'SA', 'AE'
   */
  validateGccPhone(raw: string, region: string): ParsedPhoneNumber {
    const upper = region.toUpperCase();

    if (!SUPPORTED_OTP_REGIONS.includes(upper as SupportedOtpRegion)) {
      throw new AppError(
        400,
        `Region "${region}" is not supported. Accepted: ${SUPPORTED_OTP_REGIONS.join(', ')}`,
      );
    }

    if (!isValidPhone(raw, upper as SupportedOtpRegion)) {
      throw new AppError(400, `Invalid phone number for region ${upper}`);
    }

    return parsePhone(raw, upper as never);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generate & send OTP
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generates a 6-digit OTP, stores its bcrypt hash in Redis, and returns
   * the plaintext code to be forwarded to an SMS gateway.
   *
   * In production, replace the logger.info line with an actual SMS API call
   * (e.g. Twilio, AWS SNS, or a local carrier API for BH/SA/AE).
   *
   * @param phoneE164  Normalised E.164 phone number (e.g. +97317123456)
   * @returns          The 6-digit code (only used for delivery — never stored plaintext)
   * @throws           429 if the rate limit is exceeded
   */
  async sendOtp(phoneE164: string): Promise<string> {
    await this.enforceRateLimit(phoneE164);

    // Generate cryptographically secure 6-digit code
    const code = String(randomInt(0, 999_999)).padStart(6, '0');

    // Hash before storage — bcrypt with low rounds (OTP lifetime is short)
    const hash = await bcrypt.hash(code, BCRYPT_ROUNDS);

    // Store hash with TTL
    await this.redis.setex(this.otpKey(phoneE164), OTP_TTL_SECONDS, hash);

    // Reset attempt counter for fresh OTP
    await this.redis.del(this.attemptKey(phoneE164));

    // In production: await smsGateway.send(phoneE164, `Your code: ${code}`);
    logger.info({ phoneE164, code }, '[OTP] Code generated (replace with SMS send in production)');

    return code;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Verify OTP
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Verifies a user-supplied code against the stored hash.
   *
   * @returns  true if the code is correct (and deletes the OTP from Redis)
   * @throws   400 if no OTP found, 400 if code is wrong, 429 if max attempts exceeded
   */
  async verifyOtp(phoneE164: string, code: string): Promise<true> {
    const storedHash = await this.redis.get(this.otpKey(phoneE164));

    if (!storedHash) {
      throw new AppError(400, 'OTP not found or expired. Please request a new code.');
    }

    // Increment attempt counter BEFORE bcrypt compare to prevent brute force
    // even if the compare is slow
    const attempts = await this.redis.incr(this.attemptKey(phoneE164));
    if (attempts === 1) {
      // Set TTL on the attempts counter equal to OTP TTL
      await this.redis.expire(this.attemptKey(phoneE164), OTP_TTL_SECONDS);
    }

    if (attempts > MAX_OTP_ATTEMPTS) {
      // Invalidate the OTP to force a new request
      await this.redis.del(this.otpKey(phoneE164));
      throw new AppError(429, 'Too many incorrect attempts. Please request a new OTP.');
    }

    const valid = await bcrypt.compare(code, storedHash);

    if (!valid) {
      const remaining = MAX_OTP_ATTEMPTS - attempts;
      throw new AppError(
        400,
        remaining > 0
          ? `Invalid code. ${remaining} attempt(s) remaining.`
          : 'Invalid code. Please request a new OTP.',
      );
    }

    // Success — delete OTP (single-use)
    await Promise.all([
      this.redis.del(this.otpKey(phoneE164)),
      this.redis.del(this.attemptKey(phoneE164)),
    ]);

    logger.info({ phoneE164 }, '[OTP] Verification successful');
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rate limiting
  // ─────────────────────────────────────────────────────────────────────────

  private async enforceRateLimit(phoneE164: string): Promise<void> {
    const key = this.rateKey(phoneE164);
    const count = await this.redis.incr(key);

    if (count === 1) {
      // First request in this window — set TTL
      await this.redis.expire(key, OTP_RATE_WINDOW_SECONDS);
    }

    if (count > MAX_OTP_REQUESTS_PER_HOUR) {
      const ttl = await this.redis.ttl(key);
      throw new AppError(
        429,
        `OTP request limit exceeded. Try again in ${Math.ceil(ttl / 60)} minute(s).`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Redis key helpers
  // ─────────────────────────────────────────────────────────────────────────

  private otpKey(phoneE164: string): string {
    return `otp:${phoneE164}`;
  }

  private attemptKey(phoneE164: string): string {
    return `otp:attempts:${phoneE164}`;
  }

  private rateKey(phoneE164: string): string {
    return `otp:rate:${phoneE164}`;
  }
}
