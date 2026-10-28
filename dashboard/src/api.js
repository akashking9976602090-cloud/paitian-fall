/**
 * api.js — ESP32 API communication utilities
 *
 * The ESP32 runs at 192.168.4.1 on its own Wi-Fi access point "FallMonitor".
 * When you run `npm run dev`, Vite proxies /api/* to http://192.168.4.1
 * so you don't hit browser CORS restrictions during development.
 *
 * If you deploy the built dashboard to a different host, update ESP32_BASE_URL
 * to point directly at the ESP32's IP (and ensure CORS headers are sent by the
 * firmware, which they are — see fall_detection.ino).
 */

// In development: use relative path (Vite proxy handles it).
// In production build deployed to a different host: set this to 'http://192.168.4.1'
export const ESP32_BASE_URL = '';

/** Fetch live sensor data from ESP32 */
export async function fetchSensorData(signal) {
  const res = await fetch(`${ESP32_BASE_URL}/api/data`, {
    signal,
    headers: { Accept: 'application/json' },
    // No caching — always fresh from hardware
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** POST to ESP32 to reset / cancel the active fall alert */
export async function postResetAlert() {
  const res = await fetch(`${ESP32_BASE_URL}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Reset failed: HTTP ${res.status}`);
  return res.json();
}
