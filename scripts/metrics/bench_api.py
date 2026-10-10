"""API benchmark: load a simulated 30-hour run (10,800 rows, one every 10 s), call each endpoint 50 times,
and compare the /api/readings payload with and without downsampling."""
import json
import time
from datetime import datetime, timedelta, timezone

import common
from common import (SEQ_BASE, cleanup_supabase, fake_lines, get, make_client, percentile, process_line,
                    start_api, stop_api, upload_pending)

START = SEQ_BASE + 4_000_000
ENDPOINTS = ["/api/health", "/api/latest", "/api/summary", "/api/readings?max_points=2000"]


def load_rows(client, rows):
    """Save `rows` readings 10 s apart ending now (a 30-hour run for 10,800), then upload them all."""
    start_ts = datetime.now(timezone.utc) - timedelta(seconds=10 * rows)
    for i, line in enumerate(fake_lines(rows, START)):
        reading = process_line(line)
        reading["ts"] = (start_ts + timedelta(seconds=10 * i)).isoformat()
        common.db.save_reading(reading, common.TEST_DB)
    while upload_pending(client, common.TEST_DB, batch_size=1000) > 0:  # big batches: this is just setup
        pass


def run(rows=10_800, calls=50):
    client = make_client()
    cleanup_supabase(client)
    common.reset_test_db()
    load_rows(client, rows)
    api = start_api(DATA_SOURCE="supabase")
    try:
        timings = {}
        for path in ENDPOINTS:
            ms = []
            for _ in range(calls):
                started = time.perf_counter()
                get(path)
                ms.append((time.perf_counter() - started) * 1000)
            timings[path] = {"p50_ms": round(percentile(ms, 50)), "p95_ms": round(percentile(ms, 95))}

        down_rows, down_bytes = get("/api/readings?max_points=2000")
        full_rows, full_bytes = get("/api/readings?max_points=1000000")  # effectively no downsampling
        rows_in_api = get("/api/summary")[0]["count"]
    finally:
        stop_api(api)
        cleanup_supabase(client)
        common.remove_test_db()

    return {
        "rows_loaded": rows_in_api,
        "calls_per_endpoint": calls,
        "endpoints": timings,
        "readings_payload": {
            "full_rows": len(full_rows),
            "full_kb": round(full_bytes / 1024),
            "downsampled_rows": len(down_rows),
            "downsampled_kb": round(down_bytes / 1024),
            "reduction_pct": round(100 * (1 - down_bytes / full_bytes), 1),
        },
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
