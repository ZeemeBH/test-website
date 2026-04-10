/**
 * @file User.entity.ts
 * Represents a platform customer or admin.
 * Phone numbers are stored in E.164 format (parsed via libphonenumber-js).
 * Passwords are bcrypt-hashed before persistence (see subscriber or service).
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Currency, UserRole } from '../types/enums';
import type { ParsedPhoneNumber } from '../types/interfaces';
import type { Order } from './Order.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // ── Personal details ───────────────────────────────────────────────────────

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  // ── Phone ─────────────────────────────────────────────────────────────────
  /**
   * E.164 representation stored as the canonical, indexed column.
   * Example: +97317123456
   */
  @Index({ unique: true })
  @Column({ name: 'phone_e164', type: 'varchar', length: 20 })
  phoneE164!: string;

  /**
   * Full parsed phone metadata stored as JSONB so we retain region context
   * for display, validation, and SMS routing without re-parsing.
   *
   * Schema: { e164, regionCode, countryCallingCode, nationalNumber }
   */
  @Column({ name: 'phone_meta', type: 'jsonb' })
  phoneMeta!: ParsedPhoneNumber;

  // ── Auth ──────────────────────────────────────────────────────────────────

  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false })
  passwordHash!: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.CUSTOMER,
  })
  role!: UserRole;

  @Column({ name: 'is_verified', type: 'boolean', default: false })
  isVerified!: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  /** Token family ID — rotated on every refresh to detect token reuse */
  @Column({ name: 'refresh_token_family', type: 'varchar', nullable: true, select: false })
  refreshTokenFamily?: string;

  // ── Preferences ───────────────────────────────────────────────────────────

  @Column({
    name: 'preferred_currency',
    type: 'enum',
    enum: Currency,
    default: Currency.BHD,
  })
  preferredCurrency!: Currency;

  /**
   * BCP-47 locale tag, e.g. "ar-BH", "en-US".
   * Used for notifications and invoice localisation.
   */
  @Column({ type: 'varchar', length: 10, default: 'en-US' })
  locale!: string;

  @Column({ name: 'profile_photo_url', type: 'varchar', length: 512, nullable: true })
  profilePhotoUrl?: string;

  // ── Timestamps ────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt?: Date;

  // ── Relations ─────────────────────────────────────────────────────────────

  @OneToMany('Order', (order: Order) => order.customer)
  orders!: Order[];

  // ── Virtual helpers ───────────────────────────────────────────────────────

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }
}
