/**
 * @file Payment.entity.ts
 *
 * Records each payment transaction associated with an order.
 * One order has at most one Payment row (OneToOne), but the payment
 * may transition through multiple statuses (PENDING → CAPTURED → REFUNDED).
 *
 * KEY DESIGN DECISIONS
 * ─────────────────────
 * 1. `amount` is NUMERIC(14,4) to handle BHD's 3 decimal places without
 *    floating-point errors.
 * 2. `gateway_response` stores the raw PSP webhook payload as JSONB for
 *    auditability without coupling the schema to a specific gateway.
 * 3. Driver payout and platform fee are stored here (mirrored from Order)
 *    to enable a clean ledger query without joining to orders.
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
import { Currency, PaymentMethod, PaymentStatus } from '../types/enums';
import type { Driver } from './Driver.entity';
import type { Order } from './Order.entity';
import type { User } from './User.entity';

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // ── Relations ─────────────────────────────────────────────────────────────

  @Index({ unique: true })
  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @OneToOne('Order', (o: Order) => o.payment, { nullable: false })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @ManyToOne('User', { nullable: false, eager: false })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @Column({ name: 'driver_id', type: 'uuid', nullable: true })
  driverId?: string;

  @ManyToOne('Driver', { nullable: true, eager: false })
  @JoinColumn({ name: 'driver_id' })
  driver?: Driver;

  // ── Amounts ───────────────────────────────────────────────────────────────

  /** Total charged to the customer */
  @Column({ type: 'numeric', precision: 14, scale: 4 })
  amount!: number;

  @Column({ type: 'enum', enum: Currency })
  currency!: Currency;

  /** Rate at transaction time (currency → USD) */
  @Column({ name: 'exchange_rate_to_usd', type: 'numeric', precision: 10, scale: 6, default: 1 })
  exchangeRateToUsd!: number;

  /** Platform share (already deducted from amount before driver payout) */
  @Column({ name: 'platform_fee', type: 'numeric', precision: 14, scale: 4 })
  platformFee!: number;

  /** Net amount credited to driver */
  @Column({ name: 'driver_payout', type: 'numeric', precision: 14, scale: 4 })
  driverPayout!: number;

  /** Amount refunded to customer (0 unless partially/fully refunded) */
  @Column({ name: 'refunded_amount', type: 'numeric', precision: 14, scale: 4, default: 0 })
  refundedAmount!: number;

  // ── Method & status ───────────────────────────────────────────────────────

  @Column({ type: 'enum', enum: PaymentMethod })
  method!: PaymentMethod;

  @Index()
  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  // ── Gateway integration ───────────────────────────────────────────────────

  /**
   * External PSP transaction / charge ID.
   * e.g. Stripe charge_id, Benefit Pay transaction ref, etc.
   */
  @Column({ name: 'gateway_transaction_id', type: 'varchar', length: 255, nullable: true })
  gatewayTransactionId?: string;

  /**
   * Raw JSON body from the PSP webhook or API response.
   * Stored verbatim for dispute resolution and reconciliation.
   * Never expose this in public API responses.
   */
  @Column({ name: 'gateway_response', type: 'jsonb', nullable: true, select: false })
  gatewayResponse?: Record<string, unknown>;

  /** Reference for refund transaction if applicable */
  @Column({ name: 'refund_transaction_id', type: 'varchar', length: 255, nullable: true })
  refundTransactionId?: string;

  // ── Reconciliation ────────────────────────────────────────────────────────

  /** Set to true once the driver payout has been processed/transferred */
  @Column({ name: 'driver_payout_settled', type: 'boolean', default: false })
  driverPayoutSettled!: boolean;

  @Column({ name: 'driver_payout_settled_at', type: 'timestamptz', nullable: true })
  driverPayoutSettledAt?: Date;

  // ── Timestamps ────────────────────────────────────────────────────────────

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'captured_at', type: 'timestamptz', nullable: true })
  capturedAt?: Date;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt?: Date;

  // ── Virtual helpers ───────────────────────────────────────────────────────

  get netAmountUsd(): number {
    return Number(((this.amount - this.refundedAmount) * this.exchangeRateToUsd).toFixed(4));
  }

  get isPaid(): boolean {
    return this.status === PaymentStatus.CAPTURED;
  }
}
