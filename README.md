# Pickup & Drop-off — Live Dispatch SaaS

On-demand logistics platform: real-time driver tracking, order dispatch, and fleet management.

## Live Demo

**Admin Dashboard:** https://zeemebh.github.io/test-website/

**API Health:** `https://pickup-dropoff-api.<your-subdomain>.workers.dev/api/v1/health`

## Cloud Deployment (Cloudflare)

The platform runs on Cloudflare's edge network — zero cold starts, global distribution.

### Required GitHub Secrets

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers/D1/KV permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `VITE_API_URL` | Worker URL (e.g. `https://pickup-dropoff-api.zeemebh.workers.dev`) |

### First-Time Setup

After adding secrets and the workflow runs:

```bash
# 1. Initialize database tables (one-time)
curl -X POST https://pickup-dropoff-api.<sub>.workers.dev/api/v1/admin/init-db \
  -H "Authorization: Bearer <JWT_ACCESS_SECRET value>"

# 2. Create admin account
curl -X POST https://pickup-dropoff-api.<sub>.workers.dev/api/v1/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@company.com","password":"YourSecurePass","firstName":"Admin","lastName":"User"}'
```

Then sign in at the dashboard with those credentials.

## Alternative: Local Development (Docker)

```bash
docker compose up --build
# API:   http://localhost:3000/api/v1/health
# Admin: http://localhost:5173
```

## Architecture

```
Driver App (RN)  ──REST/WS──►┐
Customer App (RN)──REST API──►│  Cloudflare Worker (Hono)
Admin Dashboard ──REST API──►│  D1 (SQLite) + KV Sessions
```

## Stack

| Layer | Tech |
|-------|------|
| API (Cloud) | Cloudflare Workers, Hono, TypeScript |
| API (Self-hosted) | Node.js, Express, TypeORM |
| Database | Cloudflare D1 (cloud) / PostgreSQL + PostGIS (self-hosted) |
| Cache/Sessions | Cloudflare KV (cloud) / Redis (self-hosted) |
| Auth | JWT access + refresh tokens, PBKDF2, RBAC |
| Admin UI | React 18, Vite, Tailwind, Mapbox GL |
| Mobile | React Native (Customer + Driver) |
| Hosting | Cloudflare Workers + GitHub Pages |
