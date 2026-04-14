import { Hono } from 'hono';
import type { Env, OrderRow } from '../types';
import { authenticate, requireRole } from '../middleware/auth';

type OrderEnv = { Bindings: Env; Variables: { userId: string; userRole: string } };

const orders = new Hono<OrderEnv>();

// All order routes require authentication
orders.use('*', authenticate());

function generateOrderNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const rand = crypto.getRandomValues(new Uint8Array(6));
  for (let i = 0; i < 6; i++) code += chars[rand[i] % chars.length];
  return `ORD-${date}-${code}`;
}

// ── GET / — list orders ─────────────────────────────────────────────────────
orders.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const status = c.req.query('status');
  const role = c.get('userRole');
  const userId = c.get('userId');

  let sql = 'SELECT * FROM orders';
  const params: (string | number)[] = [];

  if (role === 'CUSTOMER') {
    sql += ' WHERE customer_id = ?';
    params.push(userId);
    if (status && status !== 'active') {
      sql += ' AND status = ?';
      params.push(status);
    } else if (status === 'active') {
      sql += " AND status NOT IN ('DELIVERED','CANCELLED','FAILED')";
    }
  } else if (status && status !== 'active') {
    sql += ' WHERE status = ?';
    params.push(status);
  } else if (status === 'active') {
    sql += " WHERE status NOT IN ('DELIVERED','CANCELLED','FAILED')";
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await c.env.DB.prepare(sql).bind(...params).all<OrderRow>();
  return c.json({ success: true, data: result.results });
});

// ── GET /:orderId ───────────────────────────────────────────────────────────
orders.get('/:orderId', async (c) => {
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(c.req.param('orderId')).first<OrderRow>();
  if (!order) return c.json({ success: false, message: 'Order not found' }, 404);

  // Customers can only see their own orders
  if (c.get('userRole') === 'CUSTOMER' && order.customer_id !== c.get('userId')) {
    return c.json({ success: false, message: 'Not found' }, 404);
  }

  return c.json({ success: true, data: order });
});

// ── POST / — create order ───────────────────────────────────────────────────
orders.post('/', async (c) => {
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const orderNumber = generateOrderNumber();

  const baseFare = body.baseFare ?? 1.0;
  const distanceFare = body.distanceFare ?? 0.5;
  const platformFee = body.platformFee ?? 0.25;
  const totalFare = baseFare + distanceFare + platformFee - (body.discount ?? 0) + (body.surcharge ?? 0);
  const driverPayout = totalFare - platformFee;

  await c.env.DB.prepare(
    `INSERT INTO orders (id, order_number, customer_id, type, status,
      pickup_address, pickup_lat, pickup_lng,
      dropoff_address, dropoff_lat, dropoff_lng,
      recipient_name, recipient_phone_e164, delivery_notes, scheduled_at,
      estimated_distance_km, estimated_duration_min,
      currency, base_fare, distance_fare, surcharge, discount, platform_fee,
      total_fare, driver_payout, payment_method)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, orderNumber, c.get('userId'), body.type ?? 'STANDARD',
    JSON.stringify(body.pickupAddress ?? {}), body.pickupLat ?? 0, body.pickupLng ?? 0,
    JSON.stringify(body.dropoffAddress ?? {}), body.dropoffLat ?? 0, body.dropoffLng ?? 0,
    body.recipientName ?? null, body.recipientPhone ?? null, body.deliveryNotes ?? null, body.scheduledAt ?? null,
    body.estimatedDistanceKm ?? null, body.estimatedDurationMin ?? null,
    body.currency ?? 'BHD', baseFare, distanceFare, body.surcharge ?? 0, body.discount ?? 0, platformFee,
    totalFare, driverPayout, body.paymentMethod ?? 'CASH',
  ).run();

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>();
  return c.json({ success: true, data: order }, 201);
});

// ── POST /:orderId/cancel ───────────────────────────────────────────────────
orders.post('/:orderId/cancel', async (c) => {
  const orderId = c.req.param('orderId');
  const body = await c.req.json().catch(() => ({}));

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<OrderRow>();
  if (!order) return c.json({ success: false, message: 'Order not found' }, 404);

  if (['DELIVERED', 'CANCELLED', 'FAILED'].includes(order.status)) {
    return c.json({ success: false, message: 'Order already in terminal state' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE orders SET status = 'CANCELLED', cancellation_reason = ?, cancellation_notes = ?,
     cancelled_by = ?, cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(
    body.reason ?? 'CUSTOMER_REQUEST',
    body.notes ?? null,
    c.get('userRole') === 'CUSTOMER' ? 'customer' : 'admin',
    orderId,
  ).run();

  return c.json({ success: true, message: 'Order cancelled' });
});

// ── Status transition endpoints (driver/admin) ─────────────────────────────
const transitions: Record<string, { from: string[]; to: string; timeCol?: string }> = {
  'en-route':  { from: ['DRIVER_ASSIGNED'], to: 'DRIVER_EN_ROUTE' },
  'arrived':   { from: ['DRIVER_EN_ROUTE'], to: 'DRIVER_ARRIVED', timeCol: 'driver_arrived_at' },
  'picked-up': { from: ['DRIVER_ARRIVED'], to: 'PICKED_UP', timeCol: 'picked_up_at' },
  'in-transit': { from: ['PICKED_UP'], to: 'IN_TRANSIT' },
  'delivered': { from: ['IN_TRANSIT'], to: 'DELIVERED', timeCol: 'delivered_at' },
};

for (const [action, config] of Object.entries(transitions)) {
  orders.post(`/:orderId/${action}`, async (c) => {
    const orderId = c.req.param('orderId');
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<OrderRow>();
    if (!order) return c.json({ success: false, message: 'Order not found' }, 404);

    if (!config.from.includes(order.status)) {
      return c.json({ success: false, message: `Cannot transition from ${order.status} to ${config.to}` }, 400);
    }

    let sql = `UPDATE orders SET status = ?, updated_at = datetime('now')`;
    const params: (string | null)[] = [config.to];
    if (config.timeCol) {
      sql += `, ${config.timeCol} = datetime('now')`;
    }
    sql += ' WHERE id = ?';
    params.push(orderId);

    await c.env.DB.prepare(sql).bind(...params).run();
    return c.json({ success: true, data: { status: config.to } });
  });
}

export { orders };
