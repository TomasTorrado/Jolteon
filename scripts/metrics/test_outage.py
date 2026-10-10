"""Outage test: go offline for N readings, come back online, and check nothing was lost or duplicated."""
import json
import os
import time

import common
from common import SEQ_BASE, cleanup_supabase, drain, fake_lines, make_client, process_line, supabase_seqs

ONLINE_BEFORE = ONLINE_AFTER = 20  # normal readings around each outage


def one_run(client, start_seq, offline_readings):
    lines = fake_lines(ONLINE_BEFORE + offline_readings + ONLINE_AFTER, start_seq)
    drain_seconds = None
    for i, line in enumerate(lines):
        offline = ONLINE_BEFORE <= i < ONLINE_BEFORE + offline_readings
        os.environ["SIMULATE_OFFLINE"] = "1" if offline else "0"
        common.db.save_reading(process_line(line), common.TEST_DB)  # save first, like the bridge
        if i == ONLINE_BEFORE + offline_readings:  # first reading back online: time the backlog drain
            started = time.perf_counter()
            drain(client)
            drain_seconds = time.perf_counter() - started
        else:
            drain(client)

    seqs = supabase_seqs(client, start_seq, start_seq + len(lines) - 1)
    return {
        "generated": len(lines),
        "in_supabase": len(set(seqs)),
        "lost": len(set(range(start_seq, start_seq + len(lines))) - set(seqs)),
        "duplicates": len(seqs) - len(set(seqs)),
        "backlog_size": offline_readings + 1,
        "drain_seconds": round(drain_seconds, 2),
    }


def run(offline_readings=300, repeats=5):
    client = make_client()
    cleanup_supabase(client)
    common.reset_test_db()
    try:
        runs = [one_run(client, SEQ_BASE + 1_000_000 + r * 10_000, offline_readings) for r in range(repeats)]
    finally:
        os.environ.pop("SIMULATE_OFFLINE", None)
        cleanup_supabase(client)
        common.remove_test_db()
    totals = {key: sum(run[key] for run in runs) for key in ("generated", "in_supabase", "lost", "duplicates")}
    totals["max_drain_seconds"] = max(run["drain_seconds"] for run in runs)
    return {"offline_readings_per_run": offline_readings, "runs": runs, "totals": totals}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
