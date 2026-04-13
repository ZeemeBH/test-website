-- Pickup & Drop-off SaaS — D1 (SQLite) Schema
-- Adapted from the PostgreSQL/PostGIS TypeORM entities

-- ─────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  first_name           TEXT NOT NULL,
  last_name            TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE,
  phone_e164           TEXT NOT NULL UNIQUE,
  phone_meta           TEXT NOT NULL DEFAULT '{}',
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK(role IN ('CUSTOMER','ADMIN','SUPPORT')),
  is_verified          INTEGER NOT NULL DEFAULT 0,
  is_active            INTEGER NOT NULL DEFAULT 1,
  refresh_token_family TEXT,
  preferred_currency   TEXT NOT NULL DEFAULT 'BHD' CHECK(preferred_currency IN ('BHD','SAR','AED','USD')),
  locale               TEXT NOT NULL DEFAULT 'en-US',
  profile_photo_url    TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT
);

-- ─────────────────────────────────────────────────────────────
-- DRIVERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drivers (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT UNIQUE,
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  email                 TEXT NOT NULL UNIQUE,
  phone_e164            TEXT NOT NULL UNIQUE,
  phone_meta            TEXT NOT NULL DEFAULT '{}',
  password_hash         TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
                          CHECK(status IN ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','DEACTIVATED')),
  is_online             INTEGER NOT NULL DEFAULT 0,
  is_available          INTEGER NOT NULL DEFAULT 0,
  vehicle_type          TEXT NOT NULL DEFAULT 'MOTORCYCLE'
                          CHECK(vehicle_type IN ('MOTORCYCLE','CAR','VAN','PICKUP_TRUCK','REFRIGERATED')),
  vehicle_make          TEXT,
  vehicle_model         TEXT,
  vehicle_year          INTEGER,
  vehicle_colour        TEXT,
  vehicle_plate         TEXT NOT NULL,
  licence_number        TEXT NOT NULL,
  licence_expiry        TEXT NOT NULL,
  documents             TEXT,
  bank_details_enc      TEXT,
  current_lat           REAL,
  current_lng           REAL,
  last_location_update  TEXT,
  rating                REAL NOT NULL DEFAULT 5.0,
  total_deliveries      INTEGER NOT NULL DEFAULT 0,
  total_cancellations   INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ─────────────────────────────────────────────────────────────
-- ORDERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                      TEXT PRIMARY KEY,
  order_number            TEXT NOT NULL UNIQUE,
  customer_id             TEXT NOT NULL,
  driver_id               TEXT,
  type                    TEXT NOT NULL DEFAULT 'STANDARD'
                            CHECK(type IN ('STANDARD','ERRAND','MULTI_STOP','COLD_CHAIN')),
  status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK(status IN ('PENDING','SEARCHING_DRIVER','DRIVER_ASSIGNED',
                              'DRIVER_EN_ROUTE','DRIVER_ARRIVED','PICKED_UP','IN_TRANSIT',
                              'DELIVERED','CANCELLED','FAILED')),
  pickup_address          TEXT NOT NULL DEFAULT '{}',
  pickup_lat              REAL NOT NULL,
  pickup_lng              REAL NOT NULL,
  dropoff_address         TEXT NOT NULL DEFAULT '{}',
  dropoff_lat             REAL NOT NULL,
  dropoff_lng             REAL NOT NULL,
  waypoints               TEXT,
  package_details         TEXT,
  requires_proof_type     TEXT NOT NULL DEFAULT 'PHOTO' CHECK(requires_proof_type IN ('SIGNATURE','PHOTO','BOTH')),
  recipient_name          TEXT,
  recipient_phone_e164    TEXT,
  delivery_notes          TEXT,
  scheduled_at            TEXT,
  estimated_distance_km   REAL,
  estimated_duration_min  INTEGER,
  actual_distance_km      REAL,
  actual_duration_min     INTEGER,
  currency                TEXT NOT NULL DEFAULT 'BHD' CHECK(currency IN ('BHD','SAR','AED','USD')),
  base_fare               REAL NOT NULL DEFAULT 0,
  distance_fare           REAL NOT NULL DEFAULT 0,
  surcharge               REAL NOT NULL DEFAULT 0,
  discount                REAL NOT NULL DEFAULT 0,
  platform_fee            REAL NOT NULL DEFAULT 0,
  total_fare              REAL NOT NULL DEFAULT 0,
  driver_payout           REAL NOT NULL DEFAULT 0,
  exchange_rate_to_usd    REAL NOT NULL DEFAULT 1,
  fare_breakdown          TEXT,
  payment_method          TEXT NOT NULL DEFAULT 'CASH' CHECK(payment_method IN ('CASH','CARD','WALLET')),
  payment_status          TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK(payment_status IN ('PENDING','AUTHORIZED','CAPTURED','FAILED',
                              'REFUNDED','PARTIALLY_REFUNDED','VOIDED')),
  proof_of_pickup         TEXT,
  proof_of_delivery       TEXT,
  customer_rating         INTEGER,
  customer_rating_comment TEXT,
  driver_rating           INTEGER,
  cancellation_reason     TEXT,
  cancellation_notes      TEXT,
  cancelled_by            TEXT,
  dispatch_attempts       INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  driver_assigned_at      TEXT,
  driver_arrived_at       TEXT,
  picked_up_at            TEXT,
  delivered_at            TEXT,
  cancelled_at            TEXT,
  FOREIGN KEY (customer_id) REFERENCES users(id),
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id  ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver_id    ON orders(driver_id);

-- ─────────────────────────────────────────────────────────────
-- PAYMENTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL UNIQUE,
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'BHD',
  method            TEXT NOT NULL DEFAULT 'CASH',
  status            TEXT NOT NULL DEFAULT 'PENDING',
  provider_ref      TEXT,
  provider_response TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
