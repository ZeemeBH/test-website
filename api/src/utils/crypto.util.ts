/**
 * @file crypto.util.ts
 * AES-256-GCM symmetric encryption for sensitive fields (bank details, etc.).
 *
 * Why AES-256-GCM:
 *  - Authenticated encryption: provides both confidentiality and integrity.
 *  - A unique 12-byte IV per encryption prevents IV reuse attacks.
 *  - The auth tag detects tampering before decryption.
 *
 * Storage format (all hex-encoded, colon-delimited):
 *   "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 *
 * The ENCRYPTION_KEY must be exactly 32 bytes (256 bits), supplied as a
 * UTF-8 string in the environment variable.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getEnv } from '../config/environment';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;   // 96-bit IV is the GCM recommendation
const TAG_LENGTH = 16;  // 128-bit auth tag

function getKey(): Buffer {
  return Buffer.from(getEnv().ENCRYPTION_KEY, 'utf8');
}

/**
 * Encrypts `plaintext` and returns the encoded blob.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Decrypts a blob produced by `encrypt()`.
 * Throws if the ciphertext has been tampered with.
 */
export function decrypt(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted blob format');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Returns a cryptographically secure random string of `byteLength` bytes
 * in hexadecimal encoding.  Useful for generating token family IDs, nonces, etc.
 */
export function randomHex(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}
