import { Hono } from 'hono';
import type { Env, UserRow } from '../types';
import { signJwt, verifyJwt, hashPassword, verifyPassword, authenticate } from '../middleware/auth';

type AuthEnv = { Bindings: Env; Variables: { userId: string; userRole: string } };

const auth = new Hono<AuthEnv>();

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── POST /setup — one-time admin account creation ───────────────────────────
auth.post('/setup', async (c) => {
  const { email, password, firstName, lastName } = await c.req.json();
  if (!email || !password) return c.json({ success: false, message: 'email and password required' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE role = ?').bind('ADMIN').first();
  if (existing) return c.json({ success: false, message: 'Admin already exists' }, 409);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await c.env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, email, phone_e164, password_hash, role, is_verified, is_active, refresh_token_family)
     VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 1, 1, ?)`
  ).bind(id, firstName || 'Admin', lastName || 'User', email, '+0000000000', passwordHash, randomHex(16)).run();

  const accessToken = await signJwt({ sub: id, role: 'ADMIN' }, c.env.JWT_ACCESS_SECRET, 900);
  const refreshToken = await signJwt({ sub: id }, c.env.JWT_REFRESH_SECRET, 604800);

  return c.json({
    success: true,
    data: { user: { id, email, firstName: firstName || 'Admin', role: 'ADMIN' }, accessToken, refreshToken },
  }, 201);
});

// ── POST /register ──────────────────────────────────────────────────────────
auth.post('/register', async (c) => {
  const body = await c.req.json();
  const { firstName, lastName, email, phone, password } = body;

  if (!firstName || !lastName || !email || !phone || !password) {
    return c.json({ success: false, message: 'All fields required' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return c.json({ success: false, message: 'Email already registered' }, 409);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const phoneE164 = phone.startsWith('+') ? phone : `+973${phone}`;

  await c.env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, email, phone_e164, phone_meta, password_hash, role, refresh_token_family)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'CUSTOMER', ?)`
  ).bind(id, firstName, lastName, email, phoneE164, JSON.stringify({ e164: phoneE164 }), passwordHash, randomHex(16)).run();

  const accessToken = await signJwt({ sub: id, role: 'CUSTOMER' }, c.env.JWT_ACCESS_SECRET, 900);
  const refreshToken = await signJwt({ sub: id }, c.env.JWT_REFRESH_SECRET, 604800);

  return c.json({
    success: true,
    data: { user: { id, email, firstName, role: 'CUSTOMER' }, accessToken, refreshToken },
  }, 201);
});

// ── POST /login ─────────────────────────────────────────────────────────────
auth.post('/login', async (c) => {
  const { email, password } = await c.req.json();
  if (!email || !password) return c.json({ success: false, message: 'Email and password required' }, 400);

  const user = await c.env.DB.prepare(
    'SELECT id, email, first_name, last_name, password_hash, role, is_active FROM users WHERE email = ?'
  ).bind(email).first<UserRow>();

  if (!user) return c.json({ success: false, message: 'Invalid email or password' }, 401);
  if (!user.is_active) return c.json({ success: false, message: 'Account is deactivated' }, 403);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return c.json({ success: false, message: 'Invalid email or password' }, 401);

  const family = randomHex(16);
  await c.env.DB.prepare(
    "UPDATE users SET refresh_token_family = ?, last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).bind(family, user.id).run();

  const accessToken = await signJwt({ sub: user.id, role: user.role }, c.env.JWT_ACCESS_SECRET, 900);
  const refreshToken = await signJwt({ sub: user.id }, c.env.JWT_REFRESH_SECRET, 604800);

  return c.json({
    success: true,
    data: {
      user: { id: user.id, email: user.email, firstName: user.first_name, role: user.role },
      accessToken,
      refreshToken,
    },
  });
});

// ── POST /refresh ───────────────────────────────────────────────────────────
auth.post('/refresh', async (c) => {
  const { refreshToken } = await c.req.json();
  if (!refreshToken) return c.json({ success: false, message: 'Refresh token required' }, 400);

  try {
    const payload = await verifyJwt(refreshToken, c.env.JWT_REFRESH_SECRET);

    const user = await c.env.DB.prepare('SELECT id, role, is_active FROM users WHERE id = ?').bind(payload.sub).first<UserRow>();
    if (!user || !user.is_active) return c.json({ success: false, message: 'User not found' }, 401);

    const family = randomHex(16);
    await c.env.DB.prepare("UPDATE users SET refresh_token_family = ?, updated_at = datetime('now') WHERE id = ?").bind(family, user.id).run();

    const newAccess = await signJwt({ sub: user.id, role: user.role }, c.env.JWT_ACCESS_SECRET, 900);
    const newRefresh = await signJwt({ sub: user.id }, c.env.JWT_REFRESH_SECRET, 604800);

    return c.json({ success: true, data: { accessToken: newAccess, refreshToken: newRefresh } });
  } catch {
    return c.json({ success: false, message: 'Invalid or expired refresh token' }, 401);
  }
});

// ── GET /me ─────────────────────────────────────────────────────────────────
auth.get('/me', authenticate(), async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id, first_name, last_name, email, phone_e164, role, preferred_currency, locale, created_at FROM users WHERE id = ?'
  ).bind(c.get('userId')).first();

  if (!user) return c.json({ success: false, message: 'User not found' }, 404);
  return c.json({ success: true, data: user });
});

// ── POST /logout ────────────────────────────────────────────────────────────
auth.post('/logout', authenticate(), async (c) => {
  await c.env.DB.prepare(
    "UPDATE users SET refresh_token_family = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(randomHex(16), c.get('userId')).run();

  return c.json({ success: true, message: 'Logged out' });
});

export { auth };
