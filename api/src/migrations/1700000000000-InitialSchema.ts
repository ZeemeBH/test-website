/**
 * @file 1700000000000-InitialSchema.ts
 * Initial TypeORM migration.
 *
 * Creates the full schema:
 *  - PostGIS extensions (uuid-ossp, pgcrypto, postgis)
 *  - users table
 *  - drivers table  (GEOGRAPHY(Point, 4326) with spatial index)
 *  - orders table   (GEOGRAPHY(Point, 4326) on pickup + dropoff)
 *  - payments table
 *
 * All monetary columns use NUMERIC(14,4) to handle BHD (3 d.p.), SAR/AED (2 d.p.)
 * without floating-point errors.
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  // ─────────────────────────────────────────────────────────────────────────
  // UP
  // ─────────────────────────────────────────────────────────────────────────

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Extensions ─────────────────────────────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "postgis"`);

    // ── Enums ───────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE user_role_enum AS ENUM ('CUSTOMER', 'ADMIN', 'SUPPORT')
    `);

    await queryRunner.query(`
      CREATE TYPE driver_status_enum AS ENUM (
        'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE vehicle_type_enum AS ENUM (
        'MOTORCYCLE', 'CAR', 'VAN', 'PICKUP_TRUCK', 'REFRIGERATED'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE order_status_enum AS ENUM (
        'PENDING', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE',
        'DRIVER_ARRIVED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED',
        'CANCELLED', 'FAILED'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE order_type_enum AS ENUM (
        'STANDARD', 'ERRAND', 'MULTI_STOP', 'COLD_CHAIN'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE proof_type_enum AS ENUM ('SIGNATURE', 'PHOTO', 'BOTH')
    `);

    await queryRunner.query(`
      CREATE TYPE cancellation_reason_enum AS ENUM (
        'CUSTOMER_REQUEST', 'DRIVER_UNAVAILABLE', 'NO_DRIVER_FOUND',
        'PACKAGE_NOT_READY', 'WRONG_ADDRESS', 'PAYMENT_FAILED',
        'SYSTEM_ERROR', 'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE currency_enum AS ENUM ('BHD', 'SAR', 'AED', 'USD')
    `);

    await queryRunner.query(`
      CREATE TYPE payment_method_enum AS ENUM ('CASH', 'CARD', 'WALLET')
    `);

    await queryRunner.query(`
      CREATE TYPE payment_status_enum AS ENUM (
        'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED',
        'REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED'
      )
    `);

    // ── users ───────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE users (
        id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        first_name           VARCHAR(100)        NOT NULL,
        last_name            VARCHAR(100)        NOT NULL,
        email                VARCHAR(255)        NOT NULL,
        phone_e164           VARCHAR(20)         NOT NULL,
        phone_meta           JSONB               NOT NULL,
        password_hash        VARCHAR(255)        NOT NULL,
        role                 user_role_enum      NOT NULL DEFAULT 'CUSTOMER',
        is_verified          BOOLEAN             NOT NULL DEFAULT FALSE,
        is_active            BOOLEAN             NOT NULL DEFAULT TRUE,
        refresh_token_family VARCHAR(255),
        preferred_currency   currency_enum       NOT NULL DEFAULT 'BHD',
        locale               VARCHAR(10)         NOT NULL DEFAULT 'en-US',
        profile_photo_url    VARCHAR(512),
        last_login_at        TIMESTAMPTZ,
        created_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX idx_users_email     ON users (email)`);
    await queryRunner.query(`CREATE UNIQUE INDEX idx_users_phone_e164 ON users (phone_e164)`);

    // ── drivers ─────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE drivers (
        id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
        first_name           VARCHAR(100)          NOT NULL,
        last_name            VARCHAR(100)          NOT NULL,
        email                VARCHAR(255)          NOT NULL,
        phone_e164           VARCHAR(20)           NOT NULL,
        phone_meta           JSONB                 NOT NULL,
        password_hash        VARCHAR(255)          NOT NULL,
        status               driver_status_enum    NOT NULL DEFAULT 'PENDING_VERIFICATION',
        is_online            BOOLEAN               NOT NULL DEFAULT FALSE,
        is_available         BOOLEAN               NOT NULL DEFAULT FALSE,
        vehicle_type         vehicle_type_enum     NOT NULL DEFAULT 'MOTORCYCLE',
        vehicle_make         VARCHAR(100),
        vehicle_model        VARCHAR(100),
        vehicle_year         SMALLINT,
        vehicle_colour       VARCHAR(50),
        vehicle_plate        VARCHAR(20)           NOT NULL,
        licence_number       VARCHAR(50)           NOT NULL,
        licence_expiry       DATE                  NOT NULL,
        documents            JSONB,
        bank_details_enc     TEXT,

        -- PostGIS GEOGRAPHY(Point, 4326)
        -- Stores WGS-84 coordinates (lon/lat) as a spheroid-based geography.
        -- ST_DWithin / ST_Distance on GEOGRAPHY work in metres without any
        -- manual projection — essential for accurate GCC coverage.
        current_location     GEOGRAPHY(Point, 4326),
        last_location_update TIMESTAMPTZ,

        rating               NUMERIC(3,2)          NOT NULL DEFAULT 5.00,
        total_deliveries     INT                   NOT NULL DEFAULT 0,
        total_cancellations  INT                   NOT NULL DEFAULT 0,
        created_at           TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ           NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX idx_drivers_email     ON drivers (email)`);
    await queryRunner.query(`CREATE UNIQUE INDEX idx_drivers_phone_e164 ON drivers (phone_e164)`);

    -- GIST index on the geography column — required for ST_DWithin to use
    -- the spatial index (otherwise it falls back to a sequential scan).
    await queryRunner.query(`
      CREATE INDEX idx_drivers_current_location
        ON drivers USING GIST (current_location)
    `);

    // ── orders ──────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE orders (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_number          VARCHAR(30)             NOT NULL,
        customer_id           UUID                    NOT NULL REFERENCES users(id),
        driver_id             UUID                    REFERENCES drivers(id),
        type                  order_type_enum         NOT NULL DEFAULT 'STANDARD',
        status                order_status_enum       NOT NULL DEFAULT 'PENDING',

        -- Pickup
        pickup_address        JSONB                   NOT NULL,
        pickup_location       GEOGRAPHY(Point, 4326)  NOT NULL,

        -- Dropoff
        dropoff_address       JSONB                   NOT NULL,
        dropoff_location      GEOGRAPHY(Point, 4326)  NOT NULL,

        -- Multi-stop
        waypoints             JSONB,

        -- Package
        package_details       JSONB,
        requires_proof_type   proof_type_enum         NOT NULL DEFAULT 'PHOTO',

        -- Recipient
        recipient_name        VARCHAR(200),
        recipient_phone_e164  VARCHAR(20),
        delivery_notes        TEXT,
        scheduled_at          TIMESTAMPTZ,

        -- Route
        estimated_distance_km NUMERIC(8,3),
        estimated_duration_min SMALLINT,
        actual_distance_km    NUMERIC(8,3),
        actual_duration_min   SMALLINT,

        -- Multi-currency pricing
        currency              currency_enum           NOT NULL DEFAULT 'BHD',
        base_fare             NUMERIC(14,4)           NOT NULL,
        distance_fare         NUMERIC(14,4)           NOT NULL,
        surcharge             NUMERIC(14,4)           NOT NULL DEFAULT 0,
        discount              NUMERIC(14,4)           NOT NULL DEFAULT 0,
        platform_fee          NUMERIC(14,4)           NOT NULL,
        total_fare            NUMERIC(14,4)           NOT NULL,
        driver_payout         NUMERIC(14,4)           NOT NULL,
        exchange_rate_to_usd  NUMERIC(10,6)           NOT NULL DEFAULT 1,
        fare_breakdown        JSONB,

        -- Payment
        payment_method        payment_method_enum     NOT NULL DEFAULT 'CASH',
        payment_status        payment_status_enum     NOT NULL DEFAULT 'PENDING',

        -- Proof
        proof_of_pickup       JSONB,
        proof_of_delivery     JSONB,

        -- Ratings
        customer_rating       SMALLINT CHECK (customer_rating BETWEEN 1 AND 5),
        customer_rating_comment TEXT,
        driver_rating         SMALLINT CHECK (driver_rating BETWEEN 1 AND 5),

        -- Cancellation
        cancellation_reason   cancellation_reason_enum,
        cancellation_notes    TEXT,
        cancelled_by          VARCHAR(20),

        dispatch_attempts     SMALLINT                NOT NULL DEFAULT 0,

        -- Timestamps
        created_at            TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
        driver_assigned_at    TIMESTAMPTZ,
        driver_arrived_at     TIMESTAMPTZ,
        picked_up_at          TIMESTAMPTZ,
        delivered_at          TIMESTAMPTZ,
        cancelled_at          TIMESTAMPTZ
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX idx_orders_order_number  ON orders (order_number)`);
    await queryRunner.query(`CREATE        INDEX idx_orders_customer_id   ON orders (customer_id)`);
    await queryRunner.query(`CREATE        INDEX idx_orders_driver_id     ON orders (driver_id)`);
    await queryRunner.query(`CREATE        INDEX idx_orders_status        ON orders (status)`);
    await queryRunner.query(`
      CREATE INDEX idx_orders_pickup_location
        ON orders USING GIST (pickup_location)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_orders_dropoff_location
        ON orders USING GIST (dropoff_location)
    `);

    // ── payments ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE payments (
        id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id                 UUID            NOT NULL REFERENCES orders(id),
        customer_id              UUID            NOT NULL REFERENCES users(id),
        driver_id                UUID            REFERENCES drivers(id),
        amount                   NUMERIC(14,4)   NOT NULL,
        currency                 currency_enum   NOT NULL,
        exchange_rate_to_usd     NUMERIC(10,6)   NOT NULL DEFAULT 1,
        platform_fee             NUMERIC(14,4)   NOT NULL,
        driver_payout            NUMERIC(14,4)   NOT NULL,
        refunded_amount          NUMERIC(14,4)   NOT NULL DEFAULT 0,
        method                   payment_method_enum  NOT NULL,
        status                   payment_status_enum  NOT NULL DEFAULT 'PENDING',
        gateway_transaction_id   VARCHAR(255),
        gateway_response         JSONB,
        refund_transaction_id    VARCHAR(255),
        driver_payout_settled    BOOLEAN         NOT NULL DEFAULT FALSE,
        driver_payout_settled_at TIMESTAMPTZ,
        created_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
        captured_at              TIMESTAMPTZ,
        refunded_at              TIMESTAMPTZ
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX idx_payments_order_id ON payments (order_id)`);
    await queryRunner.query(`CREATE        INDEX idx_payments_status   ON payments (status)`);

    // ── updated_at auto-update trigger ──────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    for (const table of ['users', 'drivers', 'orders', 'payments']) {
      await queryRunner.query(`
        CREATE TRIGGER trg_${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
      `);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOWN
  // ─────────────────────────────────────────────────────────────────────────

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['payments', 'orders', 'drivers', 'users']) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
      await queryRunner.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    await queryRunner.query(`DROP FUNCTION IF EXISTS set_updated_at`);

    for (const type of [
      'payment_status_enum', 'payment_method_enum', 'currency_enum',
      'cancellation_reason_enum', 'proof_type_enum', 'order_type_enum',
      'order_status_enum', 'vehicle_type_enum', 'driver_status_enum', 'user_role_enum',
    ]) {
      await queryRunner.query(`DROP TYPE IF EXISTS ${type}`);
    }
  }
}
