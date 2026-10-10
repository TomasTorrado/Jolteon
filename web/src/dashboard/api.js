// Thin wrapper around the 4 GET endpoints in api/main.py.
// Base URL: leave VITE_API_URL empty and proxy /api in vite.config.js (see README),
// or set VITE_API_URL=http://localhost:8000 and enable CORS on the backend.
const BASE = import.meta.env?.VITE_API_URL ?? '';

async function get(path, params, signal) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(`${BASE}/api${path}${qs}`, { signal });
  if (!res.ok) throw new Error(`GET /api${path} failed (${res.status})`);
  return res.json();
}

export const getHealth = (signal) => get('/health', null, signal);

// One reading object, or null when the table is empty.
export const getLatest = (signal) => get('/latest', null, signal);

// {first_ts, latest_ts, count, energy_wh, charge_mah, avg_power_w}
export const getSummary = (signal) => get('/summary', null, signal);

// Array of readings, oldest first.
export const getReadings = (sinceMs, maxPoints, signal) =>
  get(
    '/readings',
    { since: new Date(sinceMs).toISOString(), max_points: String(maxPoints) },
    signal,
  );
