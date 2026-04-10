/**
 * @file order-number.util.ts
 * Generates human-readable, URL-safe order reference numbers.
 *
 * Format: ORD-{YYYYMMDD}-{6-char uppercase base-36 nanoid}
 * Example: ORD-20241215-X7KP2F
 *
 * Collision probability with 6 base-36 chars (36^6 ≈ 2.17 billion)
 * is negligible for typical logistics volumes.
 */

import { randomBytes } from 'crypto';

const BASE36_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomBase36(length: number): string {
  const bytes = randomBytes(length * 2); // over-sample for uniform distribution
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE36_CHARS[bytes[i] % BASE36_CHARS.length];
  }
  return result;
}

function todayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

export function generateOrderNumber(): string {
  return `ORD-${todayYYYYMMDD()}-${randomBase36(6)}`;
}
