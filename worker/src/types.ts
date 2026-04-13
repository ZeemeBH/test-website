export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  DEFAULT_CURRENCY: string;
  CORS_ORIGIN: string;
}

export interface JwtPayload {
  sub: string;
  role: string;
  exp: number;
  iat: number;
}

export interface UserRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_e164: string;
  phone_meta: string;
  password_hash: string;
  role: string;
  is_verified: number;
  is_active: number;
  refresh_token_family: string | null;
  preferred_currency: string;
  locale: string;
  profile_photo_url: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface DriverRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_e164: string;
  status: string;
  is_online: number;
  is_available: number;
  vehicle_type: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_plate: string;
  current_lat: number | null;
  current_lng: number | null;
  rating: number;
  total_deliveries: number;
  created_at: string;
}

export interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  driver_id: string | null;
  type: string;
  status: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  currency: string;
  total_fare: number;
  payment_method: string;
  payment_status: string;
  created_at: string;
  updated_at: string;
}
