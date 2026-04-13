import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { auth } from './routes/auth';
import { orders } from './routes/orders';
import { drivers } from './routes/drivers';

type AppEnv = { Bindings: Env; Variables: { userId: string; userRole: string } };

const app = new Hono<AppEnv>();

// ── CORS ────────────────────────────────────────────────────────────────────
app.use('*', cors({
  origin: (origin) => {
    // Allow GitHub Pages, localhost dev, and any custom domain
    const allowed = [
      'https://zeemebh.github.io',
      'http://localhost:5173',
      'http://localhost:3000',
    ];
    if (!origin || allowed.some(a => origin.startsWith(a))) return origin || '*';
    return '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/v1/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    platform: 'cloudflare-workers',
    region: (c.req.raw as any).cf?.colo ?? 'unknown',
  });
});

// ── Database init (run once) ────────────────────────────────────────────────
app.post('/api/v1/admin/init-db', async (c) => {
  const authHeader = c.req.header('Authorization');
  // Protect with a simple secret check
  if (authHeader !== `Bearer ${c.env.JWT_ACCESS_SECRET}`) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }

  try {
    // Create tables — D1 supports multi-statement in batch
    await c.env.DB.batch([
      c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, phone_e164 TEXT NOT NULL UNIQUE,
        phone_meta TEXT NOT NULL DEFAULT '{}', password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'CUSTOMER', is_verified INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1, refresh_token_family TEXT,
        preferred_currency TEXT NOT NULL DEFAULT 'BHD', locale TEXT NOT NULL DEFAULT 'en-US',
        profile_photo_url TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT
      )`),
      c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY, user_id TEXT UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, phone_e164 TEXT NOT NULL UNIQUE,
        phone_meta TEXT NOT NULL DEFAULT '{}', password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
        is_online INTEGER NOT NULL DEFAULT 0, is_available INTEGER NOT NULL DEFAULT 0,
        vehicle_type TEXT NOT NULL DEFAULT 'MOTORCYCLE', vehicle_make TEXT,
        vehicle_model TEXT, vehicle_year INTEGER, vehicle_colour TEXT,
        vehicle_plate TEXT NOT NULL, licence_number TEXT NOT NULL, licence_expiry TEXT NOT NULL,
        documents TEXT, bank_details_enc TEXT, current_lat REAL, current_lng REAL,
        last_location_update TEXT, rating REAL NOT NULL DEFAULT 5.0,
        total_deliveries INTEGER NOT NULL DEFAULT 0, total_cancellations INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL,
        driver_id TEXT, type TEXT NOT NULL DEFAULT 'STANDARD',
        status TEXT NOT NULL DEFAULT 'PENDING',
        pickup_address TEXT NOT NULL DEFAULT '{}', pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL,
        dropoff_address TEXT NOT NULL DEFAULT '{}', dropoff_lat REAL NOT NULL, dropoff_lng REAL NOT NULL,
        waypoints TEXT, package_details TEXT, requires_proof_type TEXT NOT NULL DEFAULT 'PHOTO',
        recipient_name TEXT, recipient_phone_e164 TEXT, delivery_notes TEXT, scheduled_at TEXT,
        estimated_distance_km REAL, estimated_duration_min INTEGER,
        actual_distance_km REAL, actual_duration_min INTEGER,
        currency TEXT NOT NULL DEFAULT 'BHD', base_fare REAL NOT NULL DEFAULT 0,
        distance_fare REAL NOT NULL DEFAULT 0, surcharge REAL NOT NULL DEFAULT 0,
        discount REAL NOT NULL DEFAULT 0, platform_fee REAL NOT NULL DEFAULT 0,
        total_fare REAL NOT NULL DEFAULT 0, driver_payout REAL NOT NULL DEFAULT 0,
        exchange_rate_to_usd REAL NOT NULL DEFAULT 1, fare_breakdown TEXT,
        payment_method TEXT NOT NULL DEFAULT 'CASH', payment_status TEXT NOT NULL DEFAULT 'PENDING',
        proof_of_pickup TEXT, proof_of_delivery TEXT,
        customer_rating INTEGER, customer_rating_comment TEXT, driver_rating INTEGER,
        cancellation_reason TEXT, cancellation_notes TEXT, cancelled_by TEXT,
        dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        driver_assigned_at TEXT, driver_arrived_at TEXT, picked_up_at TEXT, delivered_at TEXT, cancelled_at TEXT
      )`),
      c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'BHD', method TEXT NOT NULL DEFAULT 'CASH',
        status TEXT NOT NULL DEFAULT 'PENDING', provider_ref TEXT, provider_response TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)'),
      c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)'),
      c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id)'),
    ]);

    return c.json({ success: true, message: 'Database initialized' });
  } catch (err: any) {
    return c.json({ success: false, message: err.message }, 500);
  }
});

// ── Dashboard stats ─────────────────────────────────────────────────────────
app.get('/api/v1/stats', async (c) => {
  const [orderStats, driverStats, revenueStats] = await Promise.all([
    c.env.DB.prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status NOT IN ('DELIVERED','CANCELLED','FAILED') THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled
    FROM orders`).first(),
    c.env.DB.prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active
    FROM drivers`).first(),
    c.env.DB.prepare(`SELECT
      COALESCE(SUM(total_fare), 0) as total_revenue,
      COALESCE(SUM(platform_fee), 0) as platform_revenue,
      COALESCE(SUM(driver_payout), 0) as driver_payouts
    FROM orders WHERE status = 'DELIVERED'`).first(),
  ]);

  return c.json({ success: true, data: { orders: orderStats, drivers: driverStats, revenue: revenueStats } });
});

// ── Mount route modules ─────────────────────────────────────────────────────
app.route('/api/v1/auth', auth);
app.route('/api/v1/orders', orders);
app.route('/api/v1/drivers', drivers);

// ── Catch-all 404 ───────────────────────────────────────────────────────────
app.all('*', (c) => {
  return c.json({ success: false, message: `Route not found: ${c.req.method} ${c.req.path}` }, 404);
});

export default app;
