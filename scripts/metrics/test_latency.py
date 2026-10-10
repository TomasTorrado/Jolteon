"""Latency test: time from the bridge receiving a line until that row is readable through the API."""
import json
import time
from datetime import datetime, timedelta

import common
from common import (SEQ_BASE, cleanup_supabase, drain, fake_lines, get, make_client, percentile,
                    process_line, start_api, stop_api)

START = SEQ_BASE + 3_000_000


def run(readings=100):
    client = make_client()
    cleanup_supabase(client)
    common.reset_test_db()
    api = start_api(DATA_SOURCE="supabase")  # the real API, reading Supabase with the publishable key
    latencies_ms = []
    try:
        for line in fake_lines(readings, START):
            received = time.perf_counter()  # the moment the bridge gets the line
            reading = process_line(line)
            common.db.save_reading(reading, common.TEST_DB)
            drain(client)

            # Ask the API for rows newer than 1 s before this reading, until this seq shows up
            since = (datetime.fromisoformat(reading["ts"]) - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
            while True:
                rows, _ = get(f"/api/readings?since={since}")
                if any(row["seq"] == reading["seq"] for row in rows):
                    break
                if time.perf_counter() - received > 30:
                    raise RuntimeError(f"seq {reading['seq']} never appeared in the API (check the RLS read policy)")
                time.sleep(0.02)
            latencies_ms.append((time.perf_counter() - received) * 1000)
    finally:
        stop_api(api)
        cleanup_supabase(client)
        common.remove_test_db()

    return {
        "readings": readings,
        "p50_ms": round(percentile(latencies_ms, 50)),
        "p95_ms": round(percentile(latencies_ms, 95)),
        "max_ms": round(max(latencies_ms)),
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
