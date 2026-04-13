import { Hono } from 'hono';
import type { Env, DriverRow } from '../types';
import { authenticate, requireRole } from '../middleware/auth';

type DriverEnv = { Bindings: Env; Variables: { userId: string; userRole: string } };

const drivers = new Hono<DriverEnv>();

drivers.use('*', authenticate());

// ── GET / — list all drivers (admin/support only) ───────────────────────────
drivers.get('/', requireRole('ADMIN', 'SUPPORT'), async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const status = c.req.query('status');
  const online = c.req.query('online');

  let sql = 'SELECT id, first_name, last_name, email, phone_e164, status, is_online, is_available, vehicle_type, vehicle_plate, current_lat, current_lng, rating, total_deliveries, created_at FROM drivers';
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) { conditions.push('status = ?'); params.push(status); }
  if (online === 'true') { conditions.push('is_online = 1'); }
  if (online === 'false') { conditions.push('is_online = 0'); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all<DriverRow>();
  return c.json({ success: true, data: result.results });
});

// ── GET /online — get all online drivers with locations ─────────────────────
drivers.get('/online', requireRole('ADMIN', 'SUPPORT'), async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id as driverId, first_name, last_name, current_lat as lat, current_lng as lng,
     is_available, vehicle_type, rating
     FROM drivers WHERE is_online = 1 AND current_lat IS NOT NULL`
  ).all();

  const data = (result.results || []).map((d: any) => ({
    driverId: d.driverId,
    name: `${d.first_name} ${d.last_name}`,
    lat: d.lat,
    lng: d.lng,
    onlineStatus: d.is_available ? 'AVAILABLE' : 'ON_JOB',
    vehicleType: d.vehicle_type,
    rating: d.rating,
    timestamp: Date.now(),
  }));

  return c.json({ success: true, data });
});

// ── GET /:driverId ──────────────────────────────────────────────────────────
drivers.get('/:driverId', requireRole('ADMIN', 'SUPPORT'), async (c) => {
  const driver = await c.env.DB.prepare(
    `SELECT id, first_name, last_name, email, phone_e164, status, is_online, is_available,
     vehicle_type, vehicle_make, vehicle_model, vehicle_plate, vehicle_colour,
     current_lat, current_lng, rating, total_deliveries, total_cancellations, created_at
     FROM drivers WHERE id = ?`
  ).bind(c.req.param('driverId')).first();

  if (!driver) return c.json({ success: false, message: 'Driver not found' }, 404);
  return c.json({ success: true, data: driver });
});

// ── PUT /:driverId/location — update driver location ────────────────────────
drivers.put('/:driverId/location', async (c) => {
  const { lat, lng } = await c.req.json();
  if (lat == null || lng == null) return c.json({ success: false, message: 'lat and lng required' }, 400);

  await c.env.DB.prepare(
    `UPDATE drivers SET current_lat = ?, current_lng = ?, last_location_update = datetime('now'),
     updated_at = datetime('now') WHERE id = ?`
  ).bind(lat, lng, c.req.param('driverId')).run();

  return c.json({ success: true });
});

// ── PUT /:driverId/status — toggle availability ─────────────────────────────
drivers.put('/:driverId/status', async (c) => {
  const { isOnline, isAvailable } = await c.req.json();

  await c.env.DB.prepare(
    `UPDATE drivers SET is_online = ?, is_available = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(isOnline ? 1 : 0, isAvailable ? 1 : 0, c.req.param('driverId')).run();

  return c.json({ success: true });
});

// ── POST /:driverId/assign/:orderId — assign driver to order ────────────────
drivers.post('/:driverId/assign/:orderId', requireRole('ADMIN'), async (c) => {
  const driverId = c.req.param('driverId');
  const orderId = c.req.param('orderId');

  await c.env.DB.prepare(
    `UPDATE orders SET driver_id = ?, status = 'DRIVER_ASSIGNED', driver_assigned_at = datetime('now'),
     updated_at = datetime('now') WHERE id = ?`
  ).bind(driverId, orderId).run();

  await c.env.DB.prepare(
    `UPDATE drivers SET is_available = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(driverId).run();

  return c.json({ success: true, message: 'Driver assigned' });
});

export { drivers };
