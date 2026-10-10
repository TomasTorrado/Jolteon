# Jolteon — project context

KnightHacks 2026 project. Waste heat from a gaming laptop (standing in for a data-center
server) is captured by 4 thermoelectric generators (TEGs) between a hot plate (the laptop)
and a cold plate (ice water). The TEGs charge NiMH batteries; on demo day the stored energy
charges an iPhone.

## Pipeline

```
ESP32 --USB serial (JSON, 1 line / 10 s)--> bridge/bridge.py
   --> bridge/readings.db (SQLite safety net)
   --> bridge/uploader.py --> Supabase Postgres (table: readings)
   --> api/ (FastAPI)  --> web/ (React dashboard)
```

| Folder | Owner / purpose |
| --- | --- |
| `firmware/test/` | Arduino sketches (ESP32 + 2× INA219). Emits the JSON lines. |
| `bridge/` | Serial reader, validator, SQLite store, Supabase uploader. |
| `api/` | FastAPI backend. **Done.** Serves JSON to the dashboard. |
| `web/` | React dashboard. **Empty — this is the current work.** |
| `scripts/` | `fake_esp32.py` (data generator), `test_db.py`. |
| `db/` | Intended home for the Postgres schema SQL. Currently empty. |

Branches: `main`, `safe_net/database`, `feat/bridge-validation`, `feat/database-setup`,
`feat/supabase-upload`, `feat/fastapi-backend`, `feat/frontend/analytics-dashboard` (frontend work).

---

## The API (what the frontend consumes)

Base URL in dev: `http://localhost:8000`. Run from the repo root:

```bash
uvicorn api.main:app --reload --port 8000
```

CORS allows `http://localhost:5173` (Vite default) plus anything in `ALLOWED_ORIGINS`.
**Only `GET` is allowed** — no POST/PUT from the browser, and no credentials/custom headers.

`api/sources.py` abstracts two interchangeable backends chosen by `DATA_SOURCE` in `.env`:
`supabase` (default) or `sqlite` (reads `bridge/readings.db` read-only, or `SQLITE_PATH`).
**The response shape is identical either way**, so the frontend never cares which is live.

### The reading object — 14 fields

This is the single row shape returned by `/api/latest` and each element of `/api/readings`.

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `ts` | string | ISO 8601 UTC | When the **bridge** received the reading (not the ESP32 clock). |
| `seq` | integer | — | Packet counter from the ESP32. Unique. **Resets to 0 if the board reboots.** |
| `phase` | string | — | `"charging"` or `"discharging"`. See the caveat below. |
| `t_hot_c` | number | °C | Hot-plate (laptop) temperature. Expected 0–90. |
| `t_cold_c` | number | °C | Cold-plate (ice water) temperature. Expected −5–40. |
| `delta_t_c` | number | °C | `t_hot_c - t_cold_c`. Computed by the bridge. **This is the driver of output** — no ΔT, no power. |
| `gen_v` | number | V | TEG array voltage. Expected 0–10. |
| `gen_ma` | number | mA | TEG array current. Expected −50–500. |
| `gen_w` | number | W | `gen_v * gen_ma / 1000`. Computed by the bridge. |
| `batt_v` | number | V | Battery voltage. Expected 3.0–4.8. |
| `batt_ma` | number | mA | Battery current. **Positive = charging, negative = discharging.** Expected −2000–500. |
| `batt_w` | number | W | `batt_v * batt_ma / 1000`. Signed, same convention. |
| `charge_mah` | number | mAh | **Running cumulative total** charge stored, straight from the ESP32. |
| `energy_wh` | number | Wh | **Running cumulative total** energy stored, straight from the ESP32. |

Fields that exist in the database but are **not** exposed by the API:
`uptime_s` (deliberately dropped in `api/sources.py:FIELDS`), and the SQLite-only
`id` and `uploaded` columns.

The authoritative column list lives in `bridge/local_db.py:COLUMNS`; the serial key
abbreviations (`th`, `tc`, `gv`, `gi`, `bv`, `bi`, `mah`, `wh`, …) are in `bridge/contract.py:KEY_MAP`.
If a field name has to change, change the contract first, then `local_db.py`, then the frontend.

### `GET /api/health`

```json
{ "ok": true, "source": "sqlite" }
```

`source` is `"sqlite"` or `"supabase"`. Useful for a "backend connected" indicator.

### `GET /api/latest`

One reading object — the newest row by `ts`.

```json
{
  "ts": "2026-10-10T14:32:10Z", "seq": 4187, "phase": "discharging",
  "t_hot_c": 52.4, "t_cold_c": 3.1, "delta_t_c": 49.3,
  "gen_v": 4.31, "gen_ma": 82.0, "gen_w": 0.353,
  "batt_v": 4.05, "batt_ma": -310.0, "batt_w": -1.2555,
  "charge_mah": 1830.2, "energy_wh": 7.41
}
```

**Returns literal `null` (not 404, not `{}`) when the table is empty.** The dashboard must
render an empty state for this — it is the normal state before the bridge is started.

### `GET /api/readings`

An **array** of reading objects, **oldest first** (`ORDER BY ts, seq`). Powers the charts.

Query params:
- `since` — ISO 8601 timestamp. Returns rows with `ts` **strictly greater than** `since`
  (exclusive, so passing the last `ts` you already have will not re-send it).
  Always `encodeURIComponent()` it: a raw `+` in a URL decodes to a space.
  A timestamp with no zone is treated as UTC. Bad format → **400**.
- `max_points` — integer, min 2, default 2000. Server-side downsampling: keeps every Nth
  row, always including the first and last. Not a `LIMIT` — it spans the whole range.

```
GET /api/readings?max_points=500
GET /api/readings?since=2026-10-10T14%3A32%3A10%2B00%3A00
```

### `GET /api/summary`

Pre-computed headline numbers for the summary cards.

```json
{
  "first_ts": "2026-10-10T14:32:10Z",
  "latest_ts": "2026-10-10T14:40:00Z",
  "count": 6,
  "energy_wh": 7.41,
  "charge_mah": 1830.2,
  "avg_power_w": 0.0
}
```

- `energy_wh` / `charge_mah` are copied from the **latest row**, not summed — they are
  already cumulative counters.
- `avg_power_w` = `latest.energy_wh / hours_of_data`, rounded to 4 dp.
  **It is `0` when the data spans under one minute** (guard against a noisy divide).
- Empty table → every field `null`/`0`: `{"first_ts":null,"latest_ts":null,"count":0,"energy_wh":0,"charge_mah":0,"avg_power_w":0}`.

### Errors

| Status | When | Body |
| --- | --- | --- |
| 400 | `since` is not ISO 8601 | `{"detail":"since must be an ISO 8601 timestamp"}` |
| 422 | `max_points` < 2 or not an integer | FastAPI validation error |
| 503 | Data source unreachable (no internet, missing SQLite file, bad keys) | `{"detail":"supabase data source unavailable"}` |

**503 is the one to design for.** Any data-source failure is funnelled into it by
`api/main.py:from_source`. The dashboard should show "backend unreachable" and keep
retrying rather than blanking the charts.

---

---

## Time-windowed views (Live / 12 h / 24 h)

All three metrics for all three windows are derivable from the **existing API with no
backend changes**, using `since`. Verified against a seeded 26 h / 9,360-row dataset.

```js
const since = new Date(Date.now() - hours * 3600_000).toISOString();
const rows  = await fetch(`/api/readings?since=${encodeURIComponent(since)}&max_points=2000`)
                .then(r => r.json());
```

| Window | `hours` | Raw rows @10 s | Rows returned (max_points=2000) | SQLite fetch |
| --- | --- | --- | --- | --- |
| Live | 5/60 | 30 | 28 (no downsampling) | ~0.00 s |
| 12 h | 12 | 4,320 | 1,440 (every 3rd) | ~0.03 s |
| 24 h | 24 | 8,640 | 1,729 (every 5th) | ~0.04 s |

### The three metrics

| Metric | How to derive | Exact? |
| --- | --- | --- |
| **Temperature difference** | `delta_t_c` per row, plotted against `ts` | Yes, per returned sample |
| **Power generated** | `gen_w` per row (instantaneous), plotted against `ts` | Yes, per returned sample |
| **Energy stored in window** | `rows.at(-1).energy_wh - rows[0].energy_wh` | **Yes** — `downsample` always keeps the first and last row, so the delta survives |

For **average power over a window**, use `energyDelta / hoursSpanned`, *not* the mean of
`gen_w` samples — the energy delta is exact, the sample mean is biased by downsampling.
(`/api/summary:avg_power_w` already does this, but only ever over the *entire* dataset,
not a window.)

### What is NOT safe from a downsampled window

`downsample` in `api/main.py:49` keeps **every Nth row** — it is not a bucketed average,
so it **aliases away peaks**. Measured on the seeded data:

| | True peak `gen_w` | API reports |
| --- | --- | --- |
| 12 h window (every 3rd row) | 1.204 W | 1.204 W |
| 24 h window (every 5th row) | 1.204 W | **1.124 W** |

The 24 h view reports a *lower* peak than the 12 h view it contains — which is impossible,
and a judge may well notice. So: **do not show "peak power" or "max ΔT" from a 12 h/24 h
window**, or raise `max_points` for those views and accept the payload size. Totals,
averages-via-energy-delta and the chart shapes are all fine.

### Supabase cost

`downsample` runs **after** all rows are fetched, and `SupabaseSource.readings` pages
1,000 rows per request. A 24 h window is therefore ~9 sequential HTTP round-trips to
Supabase before a single point is downsampled — expect seconds, not milliseconds, and
show a loading state. SQLite has no such cost. Fetch the 12 h/24 h views **once** on
tab-switch and poll only the live view.

### Client-side caching strategy (IndexedDB)

Readings are **append-only and immutable** — a row never changes once written — and `since`
is **exclusive** (verified: the boundary row is not re-sent). So the cache needs no
invalidation logic, just append. Measured payloads on a 26 h / 9,360-row dataset:

| Fetch | Rows | Raw | Gzipped |
| --- | --- | --- | --- |
| Cold 24 h, raw (`max_points=100000`) | 8,471 | 2,009 K | 238 K |
| Cold 24 h, downsampled (`max_points=2000`) | 1,695 | 402 K | 52 K |
| Cold 24 h, for display (`max_points=400`) | 386 | 92 K | 14 K |
| Returning visitor, away 30 s | 3 | 0.7 K | 0.3 K |
| Returning visitor, away 10 min | 60 | 14 K | 2.0 K |
| Returning visitor, away 2 h | 720 | 171 K | 21 K |

~243 bytes per row. A returning visitor who was away 10 minutes fetches **14 K instead of
2 MB** — about 140× less, and one Supabase round-trip instead of nine.

**Cache raw rows, downsample client-side for display.** Pass `max_points=100000` to defeat
the server-side downsampler and store the raw rows. This also **fixes the peak-aliasing
problem above** — once the browser owns the raw samples it can bucket them properly into
min/avg/max per pixel column, so "peak power" becomes safe to display on the 24 h view.
Two problems, one architecture.

Use **IndexedDB, not localStorage**: 2 MB of JSON is uncomfortably close to localStorage's
5 MB cap, and its synchronous API would block the main thread parsing it on every load.

Load sequence:

1. `GET /api/health` → key the cache store by its `source` field, so `sqlite` dev data can
   never pollute the `supabase` view (or vice versa).
2. Read cached rows; drop anything older than 24 h.
3. Cache empty, or newest cached row older than 24 h → cold load the full window.
   Otherwise → `GET /api/readings?since=<newest cached ts>&max_points=100000` and append.
4. Poll only the live tail on an interval; the 12 h/24 h views are then free.

For a fast first paint, fetch `max_points=400` (14 K gzipped) to draw the chart
immediately, then backfill the raw rows in the background and re-render.

**Reboot interaction:** on append, if the incoming `seq` is lower than the newest cached
`seq`, or `energy_wh` steps backwards, the ESP32 rebooted (see the bug below). Start a new
session segment rather than appending blindly, or the cumulative chart will draw a cliff.

HTTP `Cache-Control`/`ETag` does not help here — the `since` URL moves on every poll and
the data changes every 10 s. IndexedDB is the right layer.

### Enable gzip on the API first (one line, 88% saving)

FastAPI does **not** compress by default, and the API does not add it — verified: a 24 h
response ships **2 MB uncompressed**. This JSON is highly repetitive and compresses ~88%:

```python
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)
```

Cheapest possible win, and it helps every endpoint whether or not the cache exists. Do this
before building any caching.

### Possible backend addition

A bucketed endpoint (e.g. `/api/series?hours=24&buckets=200` returning per-bucket
`min`/`avg`/`max` of `gen_w`, `batt_w`, `delta_t_c` plus the energy delta) would make the
long windows both correct on peaks and far cheaper on Supabase. Purely additive to
`api/main.py` + `api/sources.py`; would not disturb existing endpoints.

---

## BUG: a mid-demo ESP32 reboot silently stops all data capture

**Confirmed by test, affects both SQLite and Supabase. This can kill the live demo.**

`bridge/local_db.py:88` declares `seq INTEGER NOT NULL UNIQUE` and `save_reading` uses
`INSERT OR IGNORE`. `seq` is the ESP32's packet counter, which **restarts at 0 on every
boot**. So after a power-cycle, every new reading collides with an existing `seq` and is
discarded — not as an error, but as a logged "duplicate":

```
ESP32 boots, sends seq 0,1,2          -> saved
ESP32 power-cycled, sends seq 0,1,2   -> SILENTLY DISCARDED (brand-new data, lost)
                          seq 3,4     -> saved
```

The bridge prints `duplicate seq=0` and carries on, the dashboard freezes, and nothing
recovers until `seq` climbs past the previous maximum. If the board had been running for
an hour at 10 s intervals, that is **360 readings / one hour of blackout**. Unplugging the
ESP32 to reposition hardware or connect the iPhone is exactly the scenario that triggers it.

`bridge/uploader.py:40` has the same flaw server-side: `upsert(..., on_conflict="seq",
ignore_duplicates=True)`.

**Fix:** stop treating `seq` alone as the identity of a reading. Either add a boot/session
id to the contract and make the key `(session_id, seq)`, or make `ts` part of the
uniqueness, or drop the `UNIQUE` constraint and de-duplicate on `(seq, ts)` instead.
This is the bridge owner's call — it is a contract change touching `contract.py`,
`local_db.py`, `uploader.py` and the Supabase table.

**Frontend mitigation meanwhile:** watch for `seq` decreasing or `energy_wh` stepping
backwards between polls and surface a "sensor restarted" warning rather than drawing a
cliff in the chart.

## Frontend notes

- **No WebSocket / SSE.** The dashboard must **poll**. Readings arrive every ~10 s, so
  poll `/api/latest` + `/api/summary` on a ~5 s interval, and grow the chart with
  `/api/readings?since=<last ts>` rather than refetching the whole history.
- **Timestamps are UTC.** `new Date(ts)` parses both the bridge's
  `2026-10-10T14:32:10.123456+00:00` and Supabase's `timestamptz` output; render in local time.
- **Signed current/power.** `batt_ma` / `batt_w` flip negative on discharge. Charts need a
  zero baseline, and gauges need to handle negative values.
- **Cumulative counters reset on reboot.** `energy_wh`, `charge_mah` and `seq` all restart
  at 0 if the ESP32 is power-cycled mid-demo, so a cumulative chart can step backwards.
  Don't assume monotonic.
- **`phase` can be a value you don't expect.** `bridge/contract.py:PHASE_MAP` only maps
  `"chg"` → `"charging"` and `"dis"` → `"discharging"`; any other code from the firmware
  **passes through unchanged**. The firmware has an `Idle` mode, so treat `phase` as an
  open string with a fallback, not a two-value enum.
- Out-of-range sensor values are **logged but kept** (`bridge/contract.py:RANGES`), so the
  charts will occasionally see physically implausible spikes. Consider clamping axes.

### Natural dashboard sections, given the data

1. **Summary cards** — `energy_wh`, `charge_mah`, `avg_power_w`, `count`, uptime from `first_ts`→`latest_ts`.
2. **Live status** — `phase` badge, `batt_v` state-of-charge gauge (3.0–4.8 V range), `gen_w` now.
3. **Temperature chart** — `t_hot_c`, `t_cold_c`, `delta_t_c` over `ts`.
4. **Power chart** — `gen_w` vs `batt_w` over `ts` (zero baseline, signed).
5. **Cumulative chart** — `energy_wh` / `charge_mah` over `ts`.
6. **Efficiency** — `batt_w / gen_w` is derivable client-side; `gen_w` vs `delta_t_c` as a
   scatter shows the thermoelectric relationship.

---

## Local development

```bash
source .venv/bin/activate
pip install -r requirements.txt            # supabase python-dotenv pyserial fastapi uvicorn

# Terminal 1 — fake data into the bridge (no hardware needed)
python3 scripts/fake_esp32.py --interval 1 | python3 bridge/bridge.py --no-upload

# Terminal 2 — API against the local SQLite file
DATA_SOURCE=sqlite uvicorn api.main:app --reload --port 8000

# Terminal 3 — dashboard
cd web && npm run dev          # Vite, port 5173
```

`scripts/fake_esp32.py --bad-lines` breaks ~1 in 5 lines, to exercise the validator.
Working against `DATA_SOURCE=sqlite` means the frontend needs no Supabase keys at all.

### `.env` (repo root, gitignored — see `.env.example`)

| Key | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | uploader + API | |
| `SUPABASE_SECRET_KEY` | `bridge/uploader.py` | Write key. Bridge only, never the API. |
| `SUPABASE_PUBLISHABLE_KEY` | `api/sources.py` | Read-only key. **Required when `DATA_SOURCE=supabase`.** |
| `DATA_SOURCE` | `api/sources.py` | `supabase` (default) or `sqlite`. |
| `SQLITE_PATH` | `api/sources.py` | Override; defaults to `bridge/readings.db`. |
| `ALLOWED_ORIGINS` | `api/main.py` | Comma-separated extra CORS origins (deployed frontend). |

## Known gaps

- The local `.env` has only `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. With the default
  `DATA_SOURCE=supabase` the API **fails at import** (`make_source()` raises at module
  level). Either add `SUPABASE_PUBLISHABLE_KEY` or set `DATA_SOURCE=sqlite`.
- `db/` has no schema SQL checked in — the Supabase `readings` table was created out of band.
- The API has no explicit Pydantic response models (the OpenAPI schemas are empty `{}`),
  so `/docs` documents the paths but not the field shapes. This file is the contract.
- Nothing serves `web/` in production yet; no deployment target chosen.

---

## The dashboard (`web/`)

Vite + React 18, no chart library — the charts are hand-rolled SVG in `Chart.jsx` on
purpose. Integrated from `jolteon-dashboard.zip` on 2026-10-10.

```
web/
  index.html            Nunito preconnect + <link>, #root, /src/main.jsx
  package.json          react 18.3.1, react-dom 18.3.1, vite 5.4.21, @vitejs/plugin-react 4.3.4
  vite.config.js        port 5173; proxies /api -> VITE_API_TARGET (default 127.0.0.1:8000)
  .env.example          VITE_API_URL / VITE_API_TARGET, both optional
  src/main.jsx          createRoot + StrictMode
  src/App.jsx           renders <Dashboard />
  src/dashboard/        AS SHIPPED, do not restyle
    Dashboard.jsx       cards, header, phone tab, raw table. PHONE_WH = 13.9 lives here
    Chart.jsx           SVG line chart, y-axis auto-zooms to data (deliberate)
    api.js              the 4 GET wrappers
    useDashboardData.js polling + WINDOWS (live 2s / 12h+24h 10s)
    dashboard.css       neumorphic tiles, @imports Nunito itself
    assets/             jolteon-logo.png, eeveelutions.png
```

### Run it

```bash
# terminal 1 - API (DATA_SOURCE=sqlite needs no Supabase keys)
DATA_SOURCE=sqlite uvicorn api.main:app --reload --port 8000
# terminal 2 - dashboard
cd web && npm install && npm run dev      # http://localhost:5173
```

The Vite dev proxy makes `/api` same-origin, so **CORS is not involved in development**
and `api.js` needs no base URL. Set `VITE_API_URL` only when the API is on another
origin, and then add that origin to `ALLOWED_ORIGINS`.

### Field contract: verified, no mapping layer

Every field the dashboard reads exists in the API response with the same name, so
`api.js` is **byte-identical to the shipped zip** — there is no rename/mapping shim to
maintain. It reads `ts seq phase t_hot_c t_cold_c delta_t_c gen_w batt_v batt_ma
charge_mah energy_wh` from a reading and `first_ts latest_ts avg_power_w` from
`/api/summary`. It does not use `gen_v`, `gen_ma` or `batt_w`, and `getHealth` is
exported but unused.

### Polling load

Each chart card polls independently (own `useState` for its window, own `useReadings`),
which is what keeps the three tab groups from affecting each other. With all three on
Live that is 3 req / 2 s, plus `/api/latest` every 2 s and `/api/summary` every 10 s —
about **2 requests/second**. Negligible against SQLite. Against Supabase a card on the
24 h tab costs ~9 paged round-trips every 10 s, so prefer `DATA_SOURCE=sqlite` while
developing. Polling pauses automatically while the tab is hidden.

### Layout breakpoints

`.jl-grid` is `repeat(auto-fit, minmax(min(320px,100%),1fr))` with a 32 px gap, inside a
1100 px-max wrapper with 28 px side padding, and there are **no media queries**. So:
3 cards in one row at viewport **>= ~1080 px**, 2 columns between ~730 and 1080 px,
single column below that and on phones.

### Backend contract checks (all verified against the live API)

| # | Check | Result |
| --- | --- | --- |
| 1 | `since` accepts `...000Z` from `new Date().toISOString()` | **Pass.** `datetime.fromisoformat` handles `Z` on Python 3.11+; this venv is 3.14.3 |
| 2 | `max_points` downsamples evenly rather than truncating | **Pass.** 24 h -> 293 of 300 points spanning the full 24.0 h |
| 3 | Readings oldest first | **Pass.** `ORDER BY ts, seq`, confirmed ascending |
| 4 | `/api/latest` returns `null` on an empty table | **Pass.** `null` with HTTP 200; `/api/summary` zeros, `/api/readings` `[]` |
| 5 | Timestamps ISO 8601 with a zone | **Pass** for SQLite (`+00:00`). Supabase side **unverified** - no publishable key available |
| 6 | `batt_ma`/`batt_w` signed, + = charging | **Pass** |
| 7 | `/api/latest` staleness vs the 20 s "No new data" threshold | **Pass.** Under 1 s on SQLite. Real ESP32 interval is well inside 20 s |

### Not yet verified visually

The browser extension was not connected during integration, so the **rendered** page was
never eyeballed: theme toggle, hover tooltips, the ring, the moving bolt and the
responsive stacking are verified only by reading the code and the CSS. The production
build compiles clean with no warnings and every module and asset resolves over the dev
server.

### Fixed: white frame around the UI in dark mode

`dashboard.css` scopes every rule under `.jl` and never touches `html`/`body`, so the
browser's default `body { margin: 8px }` showed as a pale frame around the panel --
invisible against the light `--bg: #ebeef5`, obvious against the dark `#262932`.

Fixed in **`web/src/global.css`** (imported by `main.jsx`), not in the shipped design
files. It resets the `html`/`body` margin, paints the root background to match the active
theme so the edges and the macOS overscroll bounce match, and sets `color-scheme` so the
scrollbar and native controls follow the theme too. The theme lives as `data-theme` on
the `.jl` div, a *descendant* of `<html>`, so the dark rule reads it upward with
`:has(.jl[data-theme='dark'])`.

The two hex values mirror `--bg` in `dashboard.css`; that file stays the source of truth,
so change both together if the palette moves.

### Careful: `bridge/readings.db` currently holds synthetic data

Integration testing seeded ~26 h of fake history (seq 1,000,000+) plus a 1 Hz feeder into
`bridge/readings.db`. **Delete that file before the real demo** or the dashboard will mix
synthetic history with real ESP32 readings:

```bash
rm bridge/readings.db bridge/readings.db-wal bridge/readings.db-shm
```

Real ESP32 `seq` starts at 0 and will not collide with the synthetic 1,000,000+ range, so
real readings would still insert — they would just sit alongside the fake ones.
