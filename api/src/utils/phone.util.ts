/**
 * @file phone.util.ts
 * Phone number parsing and validation backed by libphonenumber-js.
 *
 * Design:
 *  - Always store in E.164 format in the database.
 *  - Carry the full ParsedPhoneNumber metadata in a JSONB column so we
 *    don't need to re-parse on every read.
 *  - The `defaultRegion` parameter is crucial for numbers entered without
 *    the country dial code (e.g. a user in Bahrain types "17123456" — we
 *    need to know it's "+973 17123456").
 *
 * Supported GCC regions: BH (+973), SA (+966), AE (+971), KW (+965),
 *                         QA (+974), OM (+968)
 */

import {
  parsePhoneNumber,
  isValidPhoneNumber,
  CountryCode,
  ParseError,
} from 'libphonenumber-js';
import type { ParsedPhoneNumber } from '../types/interfaces';

/**
 * Parses a raw phone number string into a normalised ParsedPhoneNumber.
 *
 * @param raw           Raw input from user, e.g. "17123456", "+97317123456", "00973 17123456"
 * @param defaultRegion ISO 3166-1 alpha-2 used when the number has no country code prefix
 * @throws              Error if the number is not parseable or invalid for the given region
 */
export function parsePhone(raw: string, defaultRegion: CountryCode = 'BH'): ParsedPhoneNumber {
  let phone;
  try {
    phone = parsePhoneNumber(raw, defaultRegion);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new Error(`Invalid phone number "${raw}": ${err.message}`);
    }
    throw err;
  }

  if (!phone.isValid()) {
    throw new Error(
      `Phone number "${raw}" is not valid for region "${phone.country ?? defaultRegion}"`,
    );
  }

  return {
    e164: phone.format('E.164'),
    regionCode: phone.country ?? defaultRegion,
    countryCallingCode: String(phone.countryCallingCode),
    nationalNumber: String(phone.nationalNumber),
  };
}

/**
 * Returns true if the raw string is a valid phone number for any region,
 * or for the specified region when provided.
 */
export function isValidPhone(raw: string, defaultRegion?: CountryCode): boolean {
  try {
    return isValidPhoneNumber(raw, defaultRegion);
  } catch {
    return false;
  }
}

/**
 * Formats a stored E.164 number into a human-friendly national format.
 * Example: "+97317123456" → "1712 3456" (BH national format)
 */
export function formatPhoneNational(e164: string): string {
  try {
    return parsePhoneNumber(e164).formatNational();
  } catch {
    return e164; // fallback to raw E.164
  }
}

/**
 * Formats a stored E.164 number into international format.
 * Example: "+97317123456" → "+973 1712 3456"
 */
export function formatPhoneInternational(e164: string): string {
  try {
    return parsePhoneNumber(e164).formatInternational();
  } catch {
    return e164;
  }
}
