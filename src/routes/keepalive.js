/**
 * keepalive.js — Prevents Render free-tier backend from sleeping
 *
 * Sends a lightweight GET /ping to the backend every 4 minutes.
 * Render's free tier sleeps after 15 minutes of inactivity.
 * This keeps it awake so users never see the 30-second cold-start delay.
 *
 * Usage: call startKeepalive() once after login, stopKeepalive() on logout.
 */

import { ROOT_URL } from '../services/api';

const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
let   intervalId       = null;
let   consecutiveFails = 0;

async function ping() {
  try {
    const res = await fetch(`${ROOT_URL}/ping`, {
      method: 'GET',
      cache:  'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      consecutiveFails = 0;
      // Optionally log: console.debug('[keepalive] ✅ ping ok');
    } else {
      consecutiveFails++;
    }
  } catch (_) {
    consecutiveFails++;
    // Silent — user may just be offline; navigator.onLine handles offline UI
  }
}

export function startKeepalive() {
  if (intervalId) return; // already running
  ping(); // immediate first ping
  intervalId = setInterval(ping, PING_INTERVAL_MS);
  console.log('[keepalive] 🟢 Started — pinging every 4 min');
}

export function stopKeepalive() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[keepalive] 🔴 Stopped');
  }
}

export function getKeepaliveStatus() {
  return { active: !!intervalId, consecutiveFails };
}
