# Jolteon

A KnightHacks project showing how waste heat from a data center could be captured and reused. An older gaming laptop under heavy load stands in for a server. Four thermoelectric generators between a hot plate (the laptop) and a cold plate (ice water) charge NiMH batteries. On demo day, the stored energy charges an iPhone.

An ESP32 measures temperatures, voltages and currents and sends one JSON line over USB every 10 seconds:

```
ESP32 --USB serial--> Python bridge --> SQLite backup --> Postgres (Lakebase) --> FastAPI --> React dashboard
```

## Build plan

1. Repo skeleton + fake ESP32 data generator
2. Bridge: read and validate serial lines, print clean readings
3. Bridge: save readings to local SQLite
4. Database table in Lakebase + uploader
5. FastAPI backend serving the readings
6. React dashboard: summary cards, then charts

## Folders

- `bridge/` – Python script that reads the ESP32 serial output and stores/uploads readings.
- `api/` – FastAPI backend that serves readings to the dashboard.
- `web/` – React dashboard with live charts.
- `scripts/` – Helper scripts, such as the fake ESP32 data generator.
- `db/` – Database schema (SQL) for Lakebase.

## Fake data

```
python3 scripts/fake_esp32.py --interval 1
```

## Metrics

`scripts/metrics/` measures how reliable and fast the pipeline is, using fake data only. From the repo root, with the venv active and `.env` filled in:

```
python3 scripts/metrics/run_all.py
```

It takes about 3 minutes and writes `scripts/metrics/results.json` (every number) and `scripts/metrics/REPORT.md` (summary table with the date and machine). Each test can also run on its own, e.g. `python3 scripts/metrics/test_outage.py`.

| Script | What it measures |
|---|---|
| `test_fuzz.py` | 10,000 lines (10% corrupted) through the bridge's validation: accepted, rejected, crashes, lines/s |
| `test_outage.py` | 5 simulated outages of 300 readings: lost, duplicated, seconds to drain the backlog |
| `test_restarts.py` | Bridge killed 20 times mid-stream with resent readings: missing and duplicate rows |
| `test_latency.py` | Line received by the bridge → readable through the API: p50 / p95 / max |
| `bench_api.py` | Each API endpoint with a simulated 30-hour run (10,800 rows), plus downsampling payload savings |

The suite uses its own SQLite file (`scripts/metrics/metrics_test.db`) and Supabase rows with `seq` ≥ 5,000,000, and deletes both when it finishes. Don't run it during the real run: it needs the uploader and the API, and it briefly adds test rows to the same Supabase table.
