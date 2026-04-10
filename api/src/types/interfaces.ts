/**
 * @file interfaces.ts
 * Shared TypeScript interfaces / value-object types used across the API.
 * These are plain data shapes — not ORM entities.
 */

import {
  Currency,
  OrderStatus,
  PaymentMethod,
  ProofType,
  VehicleType,
} from './enums';

// ─────────────────────────────────────────────────────────────────────────────
// GEO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GeoJSON Point as stored in PostGIS GEOGRAPHY(Point, 4326).
 * Longitude first, matching the GeoJSON spec (RFC 7946 §3.1.2).
 */
export interface GeoPoint {
  type: 'Point';
  coordinates: [longitude: number, latitude: number];
}

/** Human-readable address stored alongside the PostGIS geography column */
export interface AddressDetails {
  /** Free-form line 1 (street + building number) */
  line1: string;
  /** Apartment, floor, unit, etc. */
  line2?: string;
  district?: string;
  city: string;
  /** ISO 3166-1 alpha-2 country code (BH, SA, AE, etc.) */
  countryCode: string;
  /** Optional postal code — not all GCC countries use them consistently */
  postalCode?: string;
  /** Optional Plus Code / Google Maps place ID for precise navigation */
  placeId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHONE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalised phone number.  Parsed via libphonenumber-js and stored in
 * E.164 format.
 */
export interface ParsedPhoneNumber {
  /** E.164 — e.g. +97317123456 */
  e164: string;
  /** ISO 3166-1 alpha-2 — e.g. "BH" */
  regionCode: string;
  /** ITU-T country calling code — e.g. 973 */
  countryCallingCode: string;
  /** Significant national number without country code — e.g. "17123456" */
  nationalNumber: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICING
// ─────────────────────────────────────────────────────────────────────────────

export interface FareBreakdown {
  currency: Currency;
  /** ISO 4217 decimal places for this currency (BHD=3, SAR=2, AED=2) */
  decimalPlaces: number;
  baseFare: number;
  distanceFare: number;
  /** Extra charges: peak hours, bad weather, heavy item, etc. */
  surcharge: number;
  discount: number;
  /** baseFare + distanceFare + surcharge − discount */
  subtotal: number;
  /** Platform fee (e.g. 15 %) */
  platformFee: number;
  /** Amount charged to the customer */
  totalFare: number;
  /** Amount credited to the driver */
  driverPayout: number;
  /** Exchange rate snapshot at booking time (relative to USD) */
  exchangeRateToUsd: number;
}

export interface PricingInput {
  distanceKm: number;
  currency: Currency;
  vehicleType: VehicleType;
  /** Weight in kg — affects surcharge for heavy items */
  weightKg?: number;
  isPeakHour?: boolean;
  promoCode?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF OF DELIVERY / PICKUP
// ─────────────────────────────────────────────────────────────────────────────

export interface ProofRecord {
  type: ProofType;
  /** Base64-encoded PNG of drawn signature (max 50 KB) */
  signatureBase64?: string;
  /** S3 / CDN URLs of delivery photos */
  photoUrls?: string[];
  /** Name of person who received/handed over the package */
  recipientName?: string;
  /** ISO 8601 timestamp of capture */
  capturedAt: string;
  /** GPS coordinates at time of capture */
  location?: GeoPoint;
}

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGE
// ─────────────────────────────────────────────────────────────────────────────

export interface PackageDetails {
  description?: string;
  /** Weight in kg */
  weightKg?: number;
  /** Dimensions in cm */
  dimensions?: { lengthCm: number; widthCm: number; heightCm: number };
  isFragile?: boolean;
  requiresColdChain?: boolean;
  declaredValue?: number;
  declaredValueCurrency?: Currency;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVER DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverDocuments {
  /** URL to uploaded national ID / passport scan */
  nationalIdUrl?: string;
  /** URL to uploaded driving licence scan */
  drivingLicenceUrl?: string;
  /** URL to vehicle registration document */
  vehicleRegistrationUrl?: string;
  /** URL to vehicle insurance certificate */
  vehicleInsuranceUrl?: string;
  /** URL to profile / selfie photo */
  profilePhotoUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT / AUTH
// ─────────────────────────────────────────────────────────────────────────────

export interface JwtAccessPayload {
  sub: string;      // user UUID
  role: string;
  iat?: number;
  exp?: number;
}

export interface JwtRefreshPayload {
  sub: string;
  jti: string;      // unique token ID for revocation
  iat?: number;
  exp?: number;
}

/** Attached to Express Request after JWT verification */
export interface AuthenticatedUser {
  id: string;
  role: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export interface NearbyDriver {
  driverId: string;
  distanceMeters: number;
  /** Cached from Redis — may differ slightly from PostGIS result */
  location: GeoPoint;
  vehicleType: VehicleType;
}

export interface DispatchAttempt {
  orderId: string;
  attemptNumber: number;
  driverIds: string[];
  startedAt: Date;
  expiresAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverLocationPayload {
  driverId: string;
  location: GeoPoint;
  heading?: number;     // degrees 0-359
  speedKmh?: number;
  timestamp: number;    // epoch ms
}

export interface OrderStatusPayload {
  orderId: string;
  status: OrderStatus;
  updatedAt: string;
  driver?: {
    id: string;
    firstName: string;
    vehicleType: VehicleType;
    location?: GeoPoint;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGINATION
// ─────────────────────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

// ─────────────────────────────────────────────────────────────────────────────
// API RESPONSE ENVELOPE
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS AUGMENTATION
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
