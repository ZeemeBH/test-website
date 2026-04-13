-- Seed data for demo
-- Admin password: "admin123" (PBKDF2-SHA256 hash generated at runtime via /api/v1/auth/setup)
-- This file seeds sample drivers and orders for the demo dashboard

-- Sample drivers (passwords set via API)
INSERT OR IGNORE INTO drivers (id, first_name, last_name, email, phone_e164, password_hash, status, is_online, is_available, vehicle_type, vehicle_plate, licence_number, licence_expiry, current_lat, current_lng, rating, total_deliveries)
VALUES
  ('d1000000-0000-0000-0000-000000000001', 'Ahmed', 'Al-Khalifa', 'ahmed@driver.test', '+97317000001', '--', 'ACTIVE', 1, 1, 'MOTORCYCLE', 'BH-1234', 'DL-001', '2027-12-31', 26.2235, 50.5876, 4.85, 142),
  ('d1000000-0000-0000-0000-000000000002', 'Fatima', 'Hassan', 'fatima@driver.test', '+97317000002', '--', 'ACTIVE', 1, 0, 'CAR', 'BH-5678', 'DL-002', '2027-06-30', 26.2100, 50.5950, 4.92, 88),
  ('d1000000-0000-0000-0000-000000000003', 'Omar', 'Said', 'omar@driver.test', '+97317000003', '--', 'ACTIVE', 1, 1, 'VAN', 'BH-9012', 'DL-003', '2026-11-15', 26.2310, 50.6100, 4.78, 203),
  ('d1000000-0000-0000-0000-000000000004', 'Layla', 'Mansoor', 'layla@driver.test', '+97317000004', '--', 'ACTIVE', 0, 0, 'CAR', 'BH-3456', 'DL-004', '2027-09-20', 26.1980, 50.5700, 4.95, 67);
