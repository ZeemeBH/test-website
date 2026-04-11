/**
 * @file enums.ts
 * Central registry of every domain enum used across entities, services,
 * and API contracts.  Import from here — never redefine inline.
 */

// ─────────────────────────────────────────────────────────────────────────────
// USER
// ─────────────────────────────────────────────────────────────────────────────

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
  SUPPORT = 'SUPPORT',
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVER
// ─────────────────────────────────────────────────────────────────────────────

export enum DriverStatus {
  /** Registered but not yet verified by ops team */
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  /** KYC/documents approved */
  ACTIVE = 'ACTIVE',
  /** Temporarily banned */
  SUSPENDED = 'SUSPENDED',
  /** Permanently removed */
  DEACTIVATED = 'DEACTIVATED',
}

export enum VehicleType {
  MOTORCYCLE = 'MOTORCYCLE',
  CAR = 'CAR',
  VAN = 'VAN',
  PICKUP_TRUCK = 'PICKUP_TRUCK',
  REFRIGERATED = 'REFRIGERATED',
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full lifecycle of an order from creation through proof-of-delivery.
 *
 * State machine:
 *
 *  PENDING ──► SEARCHING_DRIVER ──► DRIVER_ASSIGNED
 *                                        │
 *                              ┌─────────▼──────────┐
 *                              │  DRIVER_EN_ROUTE   │  (heading to pickup)
 *                              └─────────┬──────────┘
 *                                        │
 *                              ┌─────────▼──────────┐
 *                              │  DRIVER_ARRIVED    │  (at pickup location)
 *                              └─────────┬──────────┘
 *                                        │
 *                              ┌─────────▼──────────┐
 *                              │     PICKED_UP      │  (package collected)
 *                              └─────────┬──────────┘
 *                                        │
 *                              ┌─────────▼──────────┐
 *                              │    IN_TRANSIT      │  (heading to dropoff)
 *                              └─────────┬──────────┘
 *                                        │
 *                              ┌─────────▼──────────┐
 *                              │  DELIVERED         │  (proof captured)
 *                              └────────────────────┘
 *
 *  Any state ──► CANCELLED | FAILED
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  SEARCHING_DRIVER = 'SEARCHING_DRIVER',
  DRIVER_ASSIGNED = 'DRIVER_ASSIGNED',
  DRIVER_EN_ROUTE = 'DRIVER_EN_ROUTE',
  DRIVER_ARRIVED = 'DRIVER_ARRIVED',
  PICKED_UP = 'PICKED_UP',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export enum OrderType {
  /** Standard sender-to-recipient delivery */
  STANDARD = 'STANDARD',
  /** Driver performs a task on customer's behalf */
  ERRAND = 'ERRAND',
  /** Multi-stop delivery (waypoints) */
  MULTI_STOP = 'MULTI_STOP',
  /** Requires cold chain / refrigerated vehicle */
  COLD_CHAIN = 'COLD_CHAIN',
}

export enum ProofType {
  SIGNATURE = 'SIGNATURE',
  PHOTO = 'PHOTO',
  BOTH = 'BOTH',
}

export enum CancellationReason {
  CUSTOMER_REQUEST = 'CUSTOMER_REQUEST',
  DRIVER_UNAVAILABLE = 'DRIVER_UNAVAILABLE',
  NO_DRIVER_FOUND = 'NO_DRIVER_FOUND',
  PACKAGE_NOT_READY = 'PACKAGE_NOT_READY',
  WRONG_ADDRESS = 'WRONG_ADDRESS',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  OTHER = 'OTHER',
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Currencies supported by the platform.
 * All monetary amounts stored as NUMERIC(14,4) in the database and handled
 * with BigDecimal-like arithmetic in the pricing engine.
 *
 * ISO 4217 decimal places: BHD=3, SAR=2, AED=2, USD=2
 */
export enum Currency {
  BHD = 'BHD',
  SAR = 'SAR',
  AED = 'AED',
  USD = 'USD',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  WALLET = 'WALLET',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  VOIDED = 'VOIDED',
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────────────────────────────────────

export enum SocketEvent {
  // Driver → Server
  DRIVER_LOCATION_UPDATE = 'driver:location:update',
  DRIVER_ACCEPT_ORDER = 'driver:order:accept',
  DRIVER_REJECT_ORDER = 'driver:order:reject',
  DRIVER_STATUS_UPDATE = 'driver:status:update',
  DRIVER_ORDER_STATUS_UPDATE = 'driver:order:status',

  // Server → Customer
  ORDER_STATUS_CHANGED = 'order:status:changed',
  DRIVER_LOCATION_BROADCAST = 'driver:location:broadcast',
  ORDER_ASSIGNED = 'order:assigned',
  ORDER_CANCELLED = 'order:cancelled',

  // Server → Driver
  NEW_ORDER_REQUEST = 'order:new:request',
  ORDER_CANCELLED_BY_CUSTOMER = 'order:cancelled:customer',

  // Common
  ERROR = 'error',
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',
}
