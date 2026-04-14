import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { DispatchDashboard } from './components/DispatchDashboard';
import type { Order } from './components/OrderQueue';

// ── Runtime config (injected via env at build time or window.__ENV__) ─────────
const API_URL   = (window as any).__ENV__?.API_URL   ?? import.meta.env.VITE_API_URL   ?? 'http://localhost:3000';
const WS_URL    = (window as any).__ENV__?.WS_URL    ?? import.meta.env.VITE_WS_URL    ?? 'http://localhost:3000';
const MB_TOKEN  = (window as any).__ENV__?.MB_TOKEN  ?? import.meta.env.VITE_MAPBOX_TOKEN ?? '';

// ── Auth: read JWT from localStorage (set after login) ───────────────────────
const accessToken = localStorage.getItem('admin_access_token') ?? '';

// ── If no token, show login prompt ───────────────────────────────────────────
if (!accessToken) {
  const root = document.getElementById('root')!;
  root.innerHTML = `
    <div style="display:grid;place-items:center;height:100vh;font-family:system-ui;background:#f1f5f9">
      <div style="background:#fff;padding:32px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);width:340px">
        <h2 style="font-size:18px;font-weight:800;color:#0f172a;margin-bottom:4px">Dispatch Control</h2>
        <p style="font-size:13px;color:#64748b;margin-bottom:20px">Sign in with your admin account</p>
        <input id="emailIn" type="email" placeholder="admin@company.com"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:8px;padding:10px 12px;font-size:13px;outline:none;margin-bottom:10px;box-sizing:border-box"/>
        <input id="passIn" type="password" placeholder="Password"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:8px;padding:10px 12px;font-size:13px;outline:none;margin-bottom:16px;box-sizing:border-box"/>
        <button id="loginBtn"
          style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:700;cursor:pointer">
          Sign In
        </button>
        <div id="loginErr" style="color:#dc2626;font-size:12px;margin-top:10px;display:none"></div>
        <hr style="margin:20px 0;border-color:#f1f5f9"/>
        <p style="font-size:11px;color:#94a3b8;text-align:center">Backend: ${API_URL}</p>
      </div>
    </div>`;

  document.getElementById('loginBtn')!.onclick = async () => {
    const email = (document.getElementById('emailIn') as HTMLInputElement).value;
    const password = (document.getElementById('passIn') as HTMLInputElement).value;
    const errEl = document.getElementById('loginErr')!;
    errEl.style.display = 'none';

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? 'Login failed');
      const { accessToken } = await res.json();
      localStorage.setItem('admin_access_token', accessToken);
      window.location.reload();
    } catch (e: any) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  };
} else {
  // ── Load initial orders then mount dashboard ────────────────────────────
  fetch(`${API_URL}/api/v1/orders?limit=50&status=active`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
    .then((r) => (r.ok ? r.json() : { data: [] }))
    .then(({ data }: { data: Order[] }) => {
      const root = createRoot(document.getElementById('root')!);
      root.render(
        <React.StrictMode>
          <DispatchDashboard
            mapboxToken={MB_TOKEN}
            serverUrl={WS_URL}
            apiBaseUrl={API_URL}
            accessToken={accessToken}
            initialOrders={data ?? []}
          />
        </React.StrictMode>,
      );
    })
    .catch(() => {
      // API unreachable — mount with empty orders, WS will populate
      const root = createRoot(document.getElementById('root')!);
      root.render(
        <React.StrictMode>
          <DispatchDashboard
            mapboxToken={MB_TOKEN}
            serverUrl={WS_URL}
            apiBaseUrl={API_URL}
            accessToken={accessToken}
            initialOrders={[]}
          />
        </React.StrictMode>,
      );
    });
}
