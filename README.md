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
