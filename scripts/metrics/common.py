"""Shared helpers for the metrics suite: paths, fake data, the test database, Supabase and the API."""
import json
import logging
import math
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRIDGE_DIR = ROOT / "bridge"
sys.path.insert(0, str(BRIDGE_DIR))  # so we can import the bridge's own modules

import local_db as db  # noqa: E402
from bridge import process_line  # noqa: E402
from uploader import make_client, upload_pending  # noqa: E402

logging.getLogger().setLevel(logging.ERROR)  # hide the bridge's expected warnings during tests

SEQ_BASE = 5_000_000  # every test row has seq >= this, so it can't mix with real data
TEST_DB = Path(__file__).parent / "metrics_test.db"  # separate from bridge/readings.db
API_PORT = 8799


def fake_lines(n, start_seq):
    """Get n lines from the real fake_esp32.py (no delay), renumbered to start at start_seq."""
    proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "fake_esp32.py"), "--interval", "0"],
                            stdout=subprocess.PIPE, text=True)
    lines = []
    for i in range(n):
        raw = json.loads(proc.stdout.readline())
        raw["seq"] = start_seq + i
        lines.append(json.dumps(raw, separators=(",", ":")))
    proc.kill()
    proc.wait()
    return lines


def reset_test_db():
    """Delete the test SQLite file (and its side files) and create an empty one."""
    remove_test_db()
    db.init_db(TEST_DB)


def remove_test_db():
    for suffix in ("", "-wal", "-shm"):
        Path(f"{TEST_DB}{suffix}").unlink(missing_ok=True)


def drain(client):
    """Upload until nothing is pending or an upload fails (same loop as bridge.upload_backlog, on the test DB)."""
    total = 0
    while (count := upload_pending(client, TEST_DB)) > 0:
        total += count
    return total


def cleanup_supabase(client):
    """Delete every test row (seq >= SEQ_BASE) from Supabase. Returns how many were deleted."""
    return client.table("readings").delete(count="exact").gte("seq", SEQ_BASE).execute().count


def supabase_seqs(client, low, high):
    """All seq values in Supabase between low and high (inclusive), paging past the 1000-row limit."""
    seqs, start = [], 0
    while True:
        page = (client.table("readings").select("seq").gte("seq", low).lte("seq", high)
                .order("seq").range(start, start + 999).execute().data)
        seqs += [row["seq"] for row in page]
        if len(page) < 1000:
            return seqs
        start += 1000


def percentile(values, p):
    """Nearest-rank percentile (p50 = median)."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def start_api(**env):
    """Start the real API (uvicorn) on API_PORT with extra env vars, and wait until it answers."""
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "api.main:app", "--port", str(API_PORT)],
                            cwd=ROOT, env={**os.environ, **env},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            get("/api/health")
            return proc
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("API did not start")


def stop_api(proc):
    proc.send_signal(signal.SIGINT)
    proc.wait(10)


def get(path):
    """GET an API path; returns (parsed JSON, payload size in bytes)."""
    with urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}{path}", timeout=30) as resp:
        body = resp.read()
    return json.loads(body), len(body)
