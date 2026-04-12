# Pickup & Drop-off — Live Dispatch SaaS

On-demand logistics platform: real-time driver tracking, order dispatch, and fleet management.

## Live Demo

**Admin Dashboard:** https://zeemebh.github.io/test-website/

## One-Click Deploy

### Backend API (Railway)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/ZeemeBH/test-website&envs=JWT_ACCESS_SECRET,JWT_REFRESH_SECRET,ENCRYPTION_KEY,DEFAULT_CURRENCY&JWT_ACCESS_SECRETDesc=64+random+chars&JWT_REFRESH_SECRETDesc=64+random+chars+different&ENCRYPTION_KEYDesc=Exactly+32+chars&DEFAULT_CURRENCYDefault=BHD)

After deploying, copy your Railway URL and add these GitHub Secrets so the admin auto-connects:

| Secret | Value |
|--------|-------|
| `VITE_API_URL` | Your Railway URL (e.g. `https://xxx.up.railway.app`) |
| `VITE_WS_URL` | Same Railway URL |

Then run: **Actions → Deploy Admin Dashboard → Run workflow**

## Local Development (Docker)

```bash
docker compose up --build
# API:   http://localhost:3000/api/v1/health
# Admin: http://localhost:5173
```

## Architecture

```
Driver App (RN)  ──WebSocket──►┐
Customer App (RN)──REST API───►│  Node.js API (Express + Socket.io)
Admin Dashboard ──WebSocket──►│  PostgreSQL + PostGIS + Redis
```

## Stack

| Layer | Tech |
|-------|------|
| API | Node.js, TypeScript, Express |
| Real-time | Socket.io, Redis pub/sub |
| Database | PostgreSQL 15 + PostGIS |
| Auth | JWT access + refresh tokens, RBAC |
| Admin UI | React 18, Vite, Tailwind, Mapbox GL |
| Mobile | React Native (Customer + Driver) |
| Hosting | Railway (API) + GitHub Pages (Admin) |
