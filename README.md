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

## Commands

Run everything from the repo root (`jolteon/`) unless a step says otherwise.

### One-time setup

```bash
python3 -m venv .venv
source .venv/bin/activate            # repeat this in every new terminal
pip install -r requirements.txt
cp .env.example .env                 # then fill in SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY
cd web && npm install && cd ..       # dashboard dependencies
```

Flash the firmware (Arduino IDE: install the **Adafruit INA219**, **OneWire** and **DallasTemperature** libraries, board **ESP32 Dev Module**, open `firmware/jolteon_esp32/jolteon_esp32.ino`, Upload). Or with arduino-cli:

```bash
python3 bridge/bridge.py --list-ports    # find the ESP32's port
arduino-cli compile --upload -p /dev/cu.usbserial-XXXX --fqbn esp32:esp32:esp32 firmware/jolteon_esp32
```

### Test without hardware

```bash
python3 scripts/fake_esp32.py --interval 1 | python3 bridge/bridge.py                     # fake data, end to end
python3 scripts/fake_esp32.py --interval 1 --bad-lines | python3 bridge/bridge.py         # with broken lines
python3 scripts/fake_esp32.py --interval 1 --reboot-every 20 | python3 bridge/bridge.py   # with ESP32 reboots
python3 scripts/fake_esp32.py --interval 1 | python3 bridge/bridge.py --no-upload        # save locally only, no Supabase
python3 scripts/test_db.py                                                                 # one test row to Supabase
python3 scripts/test_db.py --cleanup                                                       # delete test rows (seq >= 900000)
```

### Before the real run

1. **Clear test data** (only if you ran tests): in the Supabase SQL Editor run `DELETE FROM readings;`, then locally:
   ```bash
   rm -f bridge/readings.db bridge/readings.db-wal bridge/readings.db-shm
   ```
2. **Zero the ESP32's saved totals:** with the bridge stopped, open the Arduino Serial Monitor at 115200 baud (line ending "Newline") and type `RESET` (`STATUS` shows the current totals). Or:
   ```bash
   python3 -c "import serial,time; s=serial.Serial('/dev/cu.usbserial-XXXX',115200); time.sleep(3); s.write(b'RESET\n'); time.sleep(1); print(s.read_all().decode(errors='replace'))"
   ```
   Close the Serial Monitor afterwards: only one program can use the port.
3. Keep the MacBook **plugged in with the lid open**.

### During the real run (three terminals)

**Terminal 1 – bridge** (the only one that matters for the data):
```bash
source .venv/bin/activate
caffeinate -dims python3 bridge/bridge.py
```
`caffeinate` keeps the Mac awake. The bridge finds the ESP32 automatically (or pass `--port /dev/cu.usbserial-XXXX`), reconnects after unplugs, and keeps uploading after Wi-Fi drops. Each reading prints `saved seq=…  energy=… Wh  uploaded=…  pending=…`; `pending` should stay at 0 except during Wi-Fi drops.

**Terminal 2 – API:**
```bash
source .venv/bin/activate
python3 -m uvicorn api.main:app --port 8000
```
Check it: `curl localhost:8000/api/summary`. To serve from the local backup instead of Supabase, set `DATA_SOURCE=sqlite` in `.env` and restart it.

**Terminal 3 – dashboard:**
```bash
cd web
npm run dev        # open the URL it prints, usually http://localhost:5173
```

The API and dashboard can be stopped and restarted at any time without losing data. If the bridge is stopped, start it again with the same command; it picks up where it left off. Don't run the metrics suite during the run.

### After the real run

```bash
python3 scripts/analyze_run.py --source supabase                         # report + charts (includes ESP32 reboots)
python3 scripts/analyze_run.py --source sqlite                           # same, from the local backup (offline)
python3 scripts/analyze_run.py --source supabase --actual-iphone-pct 38  # add the % the phone actually gained
```

Writes `scripts/metrics/run_report.md`, `scripts/metrics/run_results.json` and the PNG charts in `scripts/metrics/charts/`.

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
