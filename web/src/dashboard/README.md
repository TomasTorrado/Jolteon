# Jolteon dashboard (React)

Needs React 18 and Vite. No other dependencies (the charts are plain SVG).

## Install

1. Copy this `dashboard/` folder into your app's `src/`.
2. Render it:

   ```jsx
   import Dashboard from './dashboard/Dashboard';
   export default function App() { return <Dashboard />; }
   ```

3. Point `/api` at FastAPI. In `vite.config.js`:

   ```js
   export default defineConfig({
     plugins: [react()],
     server: { proxy: { '/api': 'http://localhost:8000' } },
   });
   ```

   (Or set `VITE_API_URL=http://localhost:8000` in `.env` and enable CORS in `api/main.py`.)

## How it polls

| What | Endpoint | Every |
|---|---|---|
| Big numbers, header, raw table | `GET /api/latest` | 2 s |
| Charts, Live tab (last 2 min) | `GET /api/readings?since=&max_points=120` | 2 s |
| Charts, 12h / 24h tabs | `GET /api/readings?since=&max_points=300` | 10 s |
| Run time, average power | `GET /api/summary` | 10 s |

Change the numbers in `WINDOWS` in `useDashboardData.js`. Polling pauses while the browser tab is hidden. If a request fails, the last good data stays on screen and the header pill says "Can't reach the API".

## Things to check

- `PHONE_WH` in `Dashboard.jsx` (13.9 Wh) is an approximate iPhone 16 battery energy.
- `since` is sent as an ISO string (`2026-10-10T14:30:00.000Z`). Make sure `api/main.py` accepts that.
- `max_points` should downsample the result. If the API returns every row for 24h, the chart will be slow.

## Themes
The button next to the trio image opens a dropdown: Jolteon (default), Flareon, Glaceon, Light.
The choice is saved in localStorage under `jolteon-theme`. Themes only change surface colours
(`[data-theme='...']` blocks at the top of `dashboard.css`); the data colours stay the same.
To add a theme, add a block there and an entry in the `THEMES` array in `Dashboard.jsx`.
