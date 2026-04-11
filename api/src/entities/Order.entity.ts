/**
 * @file Order.entity.ts
 *
 * Central entity of the platform.  Encapsulates the full lifecycle of a
 * delivery from creation through proof-of-delivery.
 *
 * KEY DESIGN DECISIONS
 * ─────────────────────
 * 1. MULTI-CURRENCY
 *    Every monetary field is stored as NUMERIC(14,4) so we retain full
 *    precision for BHD (3 decimal places), SAR/AED/USD (2 decimal places).
 *    The `currency` column records the denomination at booking time.
 *    `exchange_rate_to_usd` snapshots the rate so historical reporting
 *    can always reconstruct the USD-equivalent without calling an external
 *    FX API.
 *
 * 2. LOCATION COLUMNS
 *    `pickup_location` and `dropoff_location` are PostGIS GEOGRAPHY(Point)
 *    for proximity queries.  Human-readable addresses are stored in JSONB
 *    columns alongside each geography so we avoid geocoding round-trips.
 *
 * 3. PROOF OF DELIVERY / PICKUP
 *    `proof_of_pickup` and `proof_of_delivery` are JSONB columns typed as
 *    ProofRecord.  They may contain a base64 signature and/or CDN photo URLs.
 *
 * 4. WAYPOINTS
 *    Multi-stop orders store intermediate stops as a JSONB array.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  CancellationReason,
  Currency,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  ProofType,
} from '../types/enums';
import type {
  AddressDetails,
  FareBreakdown,
  PackageDetails,
  ProofRecord,
} from '../types/interfaces';
import type { Driver } from './Driver.entity';
import type { Payment } from './Payment.entity';
import type { User } from './User.entity';

/** A single waypoint in a multi-stop order */
interface WaypointStop {
  sequence: number;
  address: AddressDetails;
  /** WKT representation of PostGIS point, resolved at creation time */
  locationWkt?: string;
  /** Optionally attach proof at each intermediate stop */
  proof?: ProofRecord;
  completedAt?: string;
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Human-readable order reference.
   * Format: ORD-{YYYYMMDD}-{6-char uppercase nanoid}
   * Example: ORD-20241215-X7KP2F
   * Generated in the service layer before insert.
   */
  @Index({ unique: true })
  @Column({ name: 'order_number', type: 'varchar', length: 30 })
  orderNumber!: string;

  // ── Participants ──────────────────────────────────────────────────────────

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @ManyToOne('User', (user: User) => user.orders, { nullable: false })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @Column({ name: 'driver_id', type: 'uuid', nullable: true })
  driverId?: string;

  @ManyToOne('Driver', (driver: Driver) => driver.orders, { nullable: true })
  @JoinColumn({ name: 'driver_id' })
  driver?: Driver;

  // ── Order classification ──────────────────────────────────────────────────

  @Column({
    type: 'enum',
    enum: OrderType,
    default: OrderType.STANDARD,
  })
  type!: OrderType;

  @Index()
  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status!: OrderStatus;

  // ── Pickup ────────────────────────────────────────────────────────────────

  @Column({ name: 'pickup_address', type: 'jsonb' })
  pickupAddress!: AddressDetails;

  /**
   * PostGIS GEOGRAPHY(Point, 4326).
   * Written as WKT 'POINT(<lng> <lat>)'.
   */
  @Index({ spatial: true })
  @Column({
    name: 'pickup_location',
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  pickupLocation!: string;

  // ── Dropoff ───────────────────────────────────────────────────────────────

  @Column({ name: 'dropoff_address', type: 'jsonb' })
  dropoffAddress!: AddressDetails;

  @Index({ spatial: true })
  @Column({
    name: 'dropoff_location',
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  dropoffLocation!: string;

  // ── Waypoints (multi-stop) ────────────────────────────────────────────────

  /** Ordered array of intermediate stops; null/empty for standard orders */
  @Column({ type: 'jsonb', nullable: true })
  waypoints?: WaypointStop[];

  // ── Package ───────────────────────────────────────────────────────────────

  @Column({ name: 'package_details', type: 'jsonb', nullable: true })
  packageDetails?: PackageDetails;

  @Column({ name: 'requires_proof_type', type: 'enum', enum: ProofType, default: ProofType.PHOTO })
  requiresProofType!: ProofType;

  // ── Recipient ─────────────────────────────────────────────────────────────

  @Column({ name: 'recipient_name', type: 'varchar', length: 200, nullable: true })
  recipientName?: string;

  @Column({ name: 'recipient_phone_e164', type: 'varchar', length: 20, nullable: true })
  recipientPhoneE164?: string;

  @Column({ name: 'delivery_notes', type: 'text', nullable: true })
  deliveryNotes?: string;

  // ── Scheduling ────────────────────────────────────────────────────────────

  /** Null = on-demand (dispatch immediately).  Set = scheduled delivery. */
  @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt?: Date;

  // ── Route estimates ───────────────────────────────────────────────────────

  @Column({ name: 'estimated_distance_km', type: 'numeric', precision: 8, scale: 3, nullable: true })
  estimatedDistanceKm?: number;

  @Column({ name: 'estimated_duration_min', type: 'smallint', nullable: true })
  estimatedDurationMin?: number;

  @Column({ name: 'actual_distance_km', type: 'numeric', precision: 8, scale: 3, nullable: true })
  actualDistanceKm?: number;

  @Column({ name: 'actual_duration_min', type: 'smallint', nullable: true })
  actualDurationMin?: number;

  // ── Multi-currency pricing ────────────────────────────────────────────────

  /**
   * Currency selected by the customer at booking time.
   * All fare columns below are denominated in this currency.
   */
  @Column({ type: 'enum', enum: Currency, default: Currency.BHD })
  currency!: Currency;

  @Column({ name: 'base_fare', type: 'numeric', precision: 14, scale: 4 })
  baseFare!: number;

  @Column({ name: 'distance_fare', type: 'numeric', precision: 14, scale: 4 })
  distanceFare!: number;

  @Column({ name: 'surcharge', type: 'numeric', precision: 14, scale: 4, default: 0 })
  surcharge!: number;

  @Column({ name: 'discount', type: 'numeric', precision: 14, scale: 4, default: 0 })
  discount!: number;

  @Column({ name: 'platform_fee', type: 'numeric', precision: 14, scale: 4 })
  platformFee!: number;

  /** Amount charged to the customer (= base + distance + surcharge − discount + platformFee) */
  @Column({ name: 'total_fare', type: 'numeric', precision: 14, scale: 4 })
  totalFare!: number;

  /** Amount credited to the driver */
  @Column({ name: 'driver_payout', type: 'numeric', precision: 14, scale: 4 })
  driverPayout!: number;

  /**
   * Exchange rate from `currency` → USD snapshotted at order creation time.
   * Enables consistent historical reporting in a single currency.
   * Example: if currency=BHD and 1 BHD = 2.65 USD, store 2.65.
   */
  @Column({ name: 'exchange_rate_to_usd', type: 'numeric', precision: 10, scale: 6, default: 1 })
  exchangeRateToUsd!: number;

  /** Full fare breakdown snapshot for auditing / invoice generation */
  @Column({ name: 'fare_breakdown', type: 'jsonb', nullable: true })
  fareBreakdown?: FareBreakdown;

  // ── Payment ───────────────────────────────────────────────────────────────

  @Column({ name: 'payment_method', type: 'enum', enum: PaymentMethod, default: PaymentMethod.CASH })
  paymentMethod!: PaymentMethod;

  @Column({ name: 'payment_status', type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  paymentStatus!: PaymentStatus;

  // ── Proof of delivery / pickup ────────────────────────────────────────────

  /**
   * Captured when the driver marks the order as PICKED_UP.
   * May include a photo of the package at sender's location.
   */
  @Column({ name: 'proof_of_pickup', type: 'jsonb', nullable: true })
  proofOfPickup?: ProofRecord;

  /**
   * Captured when the driver marks the order as DELIVERED.
   * Contains signature and/or photo evidence.
   */
  @Column({ name: 'proof_of_delivery', type: 'jsonb', nullable: true })
  proofOfDelivery?: ProofRecord;

  // ── Ratings ───────────────────────────────────────────────────────────────

  @Column({ name: 'customer_rating', type: 'smallint', nullable: true })
  customerRating?: number;

  @Column({ name: 'customer_rating_comment', type: 'text', nullable: true })
  customerRatingComment?: string;

  @Column({ name: 'driver_rating', type: 'smallint', nullable: true })
  driverRating?: number;

  // ── Cancellation ──────────────────────────────────────────────────────────

  @Column({ name: 'cancellation_reason', type: 'enum', enum: CancellationReason, nullable: true })
  cancellationReason?: CancellationReason;

  @Column({ name: 'cancellation_notes', type: 'text', nullable: true })
  cancellationNotes?: string;

  /** Who initiated the cancellation: 'customer' | 'driver' | 'system' */
  @Column({ name: 'cancelled_by', type: 'varchar', length: 20, nullable: true })
  cancelledBy?: string;

  // ── Dispatch tracking ─────────────────────────────────────────────────────

  /** Number of dispatch attempts before a driver was assigned */
  @Column({ name: 'dispatch_attempts', type: 'smallint', default: 0 })
  dispatchAttempts!: number;

  // ── Timestamps ────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'driver_assigned_at', type: 'timestamptz', nullable: true })
  driverAssignedAt?: Date;

  @Column({ name: 'driver_arrived_at', type: 'timestamptz', nullable: true })
  driverArrivedAt?: Date;

  @Column({ name: 'picked_up_at', type: 'timestamptz', nullable: true })
  pickedUpAt?: Date;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  // ── Relations ─────────────────────────────────────────────────────────────

  @OneToOne('Payment', (p: Payment) => p.order, { nullable: true })
  payment?: Payment;

  // ── Virtual helpers ───────────────────────────────────────────────────────

  get isTerminal(): boolean {
    return [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.FAILED].includes(this.status);
  }

  get totalFareUsd(): number {
    return Number((this.totalFare * this.exchangeRateToUsd).toFixed(4));
  }
}
