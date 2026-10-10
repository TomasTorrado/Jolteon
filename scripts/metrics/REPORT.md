# Pipeline metrics

Run on 2026-10-10 12:54 · Apple M4 (Mac16,1), macOS 26.5.2, Python 3.14.7 · fake ESP32 data only

## Reliability

| Test | Result | Pass |
|---|---|---|
| Fuzz: 10,000 lines, 1,000 corrupted | 9,000 accepted, 1,000 rejected, 0 wrong, 0 crashes | ✅ |
| Outage: 5 × 300 readings offline | 1,700 generated, 1,700 in Supabase, 0 lost, 0 duplicates | ✅ |
| Restarts: bridge killed 20× mid-stream | 316 expected, 110 resent, 0 missing, 0 duplicates | ✅ |

## Speed

| Metric | Value |
|---|---|
| Validation throughput | 233,159 lines/s |
| Backlog drain after outage (301 readings) | ≤ 0.41 s |
| Line received → readable via API (n=100) | p50 139 ms · p95 230 ms · max 655 ms |
| `/api/health` with 10,800 rows (50 calls) | p50 0 ms · p95 1 ms |
| `/api/latest` with 10,800 rows (50 calls) | p50 60 ms · p95 134 ms |
| `/api/summary` with 10,800 rows (50 calls) | p50 242 ms · p95 299 ms |
| `/api/readings?max_points=2000` with 10,800 rows (50 calls) | p50 1428 ms · p95 1652 ms |
| `/api/readings` payload: full vs. downsampled | 10,800 rows / 2,469 KB → 1,801 rows / 412 KB (**−83.3%**) |
