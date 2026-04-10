/**
 * @file Driver.entity.ts
 *
 * The Driver is a separate entity from User because it carries a distinct
 * set of operational data (vehicle, licence, rating, live location) that
 * would otherwise pollute the User table.
 *
 * KEY DESIGN DECISIONS
 * ─────────────────────
 * 1. `current_location` is typed as PostGIS GEOGRAPHY(Point, 4326).
 *    GEOGRAPHY (vs GEOMETRY) stores coordinates as spheroid-based WGS-84,
 *    giving us distance/area functions that work in metres/km natively and
 *    correctly across the globe without extra projection steps.
 *
 * 2. Sensitive fields (bank account details) are AES-256-GCM encrypted at
 *    the application layer before write, and decrypted after read.
 *    The column type is `text` (encrypted blob); the `select: false`
 *    guard prevents accidental exposure in API responses.
 *
 * 3. Phone numbers follow the same E.164 + JSONB-meta pattern as User.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DriverStatus, VehicleType } from '../types/enums';
import type { DriverDocuments, ParsedPhoneNumber } from '../types/interfaces';
import type { Order } from './Order.entity';
import type { User } from './User.entity';

@Entity('drivers')
export class Driver {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // ── Linked user account ────────────────────────────────────────────────────

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string;

  @OneToOne('User', { nullable: true, eager: false })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  // ── Personal details ───────────────────────────────────────────────────────

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Index({ unique: true })
  @Column({ name: 'phone_e164', type: 'varchar', length: 20 })
  phoneE164!: string;

  @Column({ name: 'phone_meta', type: 'jsonb' })
  phoneMeta!: ParsedPhoneNumber;

  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false })
  passwordHash!: string;

  // ── Verification & status ─────────────────────────────────────────────────

  @Column({
    type: 'enum',
    enum: DriverStatus,
    default: DriverStatus.PENDING_VERIFICATION,
  })
  status!: DriverStatus;

  /** Driver is currently connected to the platform (websocket session active) */
  @Column({ name: 'is_online', type: 'boolean', default: false })
  isOnline!: boolean;

  /** Driver is online AND willing to accept new orders */
  @Column({ name: 'is_available', type: 'boolean', default: false })
  isAvailable!: boolean;

  // ── Vehicle ───────────────────────────────────────────────────────────────

  @Column({
    name: 'vehicle_type',
    type: 'enum',
    enum: VehicleType,
    default: VehicleType.MOTORCYCLE,
  })
  vehicleType!: VehicleType;

  @Column({ name: 'vehicle_make', type: 'varchar', length: 100, nullable: true })
  vehicleMake?: string;

  @Column({ name: 'vehicle_model', type: 'varchar', length: 100, nullable: true })
  vehicleModel?: string;

  @Column({ name: 'vehicle_year', type: 'smallint', nullable: true })
  vehicleYear?: number;

  @Column({ name: 'vehicle_colour', type: 'varchar', length: 50, nullable: true })
  vehicleColour?: string;

  /** Licence plate in the country of registration */
  @Column({ name: 'vehicle_plate', type: 'varchar', length: 20 })
  vehiclePlate!: string;

  // ── Licence ───────────────────────────────────────────────────────────────

  @Column({ name: 'licence_number', type: 'varchar', length: 50 })
  licenceNumber!: string;

  @Column({ name: 'licence_expiry', type: 'date' })
  licenceExpiry!: Date;

  // ── Documents (URLs / CDN paths) ──────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  documents?: DriverDocuments;

  // ── Bank / payout details (AES-256-GCM encrypted blob) ───────────────────

  /**
   * Stores an AES-256-GCM ciphertext produced by CryptoUtil.encrypt().
   * Format:  "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
   *
   * NEVER log or return this field in API responses — guarded by `select: false`.
   */
  @Column({ name: 'bank_details_enc', type: 'text', nullable: true, select: false })
  bankDetailsEnc?: string;

  // ── Live location (PostGIS) ───────────────────────────────────────────────

  /**
   * PostGIS GEOGRAPHY(Point, 4326).
   *
   * TypeORM raw column keeps the DDL simple; we use raw SQL / query builder
   * for spatial queries (ST_DWithin, ST_Distance) in GeoService.
   *
   * The column value is written as WKT: 'POINT(<lng> <lat>)'
   * and read back as a GeoJSON string via ST_AsGeoJSON() in GeoService queries.
   */
  @Index({ spatial: true })
  @Column({
    name: 'current_location',
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  currentLocation?: string; // serialised GeoJSON string or WKT from PostGIS

  @Column({ name: 'last_location_update', type: 'timestamptz', nullable: true })
  lastLocationUpdate?: Date;

  // ── Performance metrics ───────────────────────────────────────────────────

  /**
   * Rolling average rating (1.0 – 5.0).
   * Updated by an atomic UPDATE … SET rating = ((rating * total_deliveries) + new_rating)
   *   / (total_deliveries + 1) to avoid a full recalculation.
   */
  @Column({ name: 'rating', type: 'numeric', precision: 3, scale: 2, default: 5.0 })
  rating!: number;

  @Column({ name: 'total_deliveries', type: 'int', default: 0 })
  totalDeliveries!: number;

  @Column({ name: 'total_cancellations', type: 'int', default: 0 })
  totalCancellations!: number;

  // ── Timestamps ────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  // ── Relations ─────────────────────────────────────────────────────────────

  @OneToMany('Order', (order: Order) => order.driver)
  orders!: Order[];

  // ── Virtual helpers ───────────────────────────────────────────────────────

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  get isLicenceExpired(): boolean {
    return this.licenceExpiry < new Date();
  }
}
