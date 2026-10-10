"""Run the whole metrics suite and write results.json and REPORT.md next to this file.

Run from the repo root:  python3 scripts/metrics/run_all.py   (takes about 3-4 minutes)
"""
import json
import platform
import subprocess
from datetime import datetime
from pathlib import Path

import bench_api
import test_fuzz
import test_latency
import test_outage
import test_restarts

HERE = Path(__file__).parent


def machine():
    """A short description of the computer, e.g. 'Apple M4 (Mac16,1), macOS 26.0, Python 3.14.7'."""
    try:
        chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string", "hw.model"],
                              capture_output=True, text=True).stdout.split("\n")
        name = f"{chip[0]} ({chip[1]})"
    except OSError:
        name = platform.machine()
    return f"{name}, macOS {platform.mac_ver()[0] or platform.platform()}, Python {platform.python_version()}"


def report(r):
    """Turn the results dict into a short Markdown summary."""
    f, o, s, l, b = r["fuzz"], r["outage"]["totals"], r["restarts"], r["latency"], r["bench_api"]
    p = b["readings_payload"]
    ok = lambda passed: "✅" if passed else "❌"  # noqa: E731
    lines = [
        "# Pipeline metrics",
        "",
        f"Run on {r['date']} · {r['machine']} · fake ESP32 data only",
        "",
        "## Reliability",
        "",
        "| Test | Result | Pass |",
        "|---|---|---|",
        f"| Fuzz: {f['lines_processed']:,} lines, {f['corrupted_lines']:,} corrupted | {f['good_accepted']:,} accepted, "
        f"{f['bad_rejected']:,} rejected, {f['wrong_verdicts']} wrong, {f['crashes']} crashes | {ok(f['crashes'] == 0 and f['wrong_verdicts'] == 0)} |",
        f"| Outage: 5 × {r['outage']['offline_readings_per_run']} readings offline | {o['generated']:,} generated, "
        f"{o['in_supabase']:,} in Supabase, {o['lost']} lost, {o['duplicates']} duplicates | {ok(o['lost'] == 0 and o['duplicates'] == 0)} |",
        f"| Restarts: bridge killed {s['restarts']}× mid-stream | {s['readings_expected']} expected, "
        f"{s['readings_resent_after_restart']} resent, {s['missing']} missing, {s['duplicates']} duplicates | {ok(s['missing'] == 0 and s['duplicates'] == 0)} |",
        "",
        "## Speed",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Validation throughput | {f['lines_per_second']:,} lines/s |",
        f"| Backlog drain after outage ({r['outage']['runs'][0]['backlog_size']} readings) | ≤ {o['max_drain_seconds']} s |",
        f"| Line received → readable via API (n={l['readings']}) | p50 {l['p50_ms']} ms · p95 {l['p95_ms']} ms · max {l['max_ms']} ms |",
    ]
    for path, t in b["endpoints"].items():
        lines.append(f"| `{path}` with {b['rows_loaded']:,} rows ({b['calls_per_endpoint']} calls) | p50 {t['p50_ms']} ms · p95 {t['p95_ms']} ms |")
    lines.append(f"| `/api/readings` payload: full vs. downsampled | {p['full_rows']:,} rows / {p['full_kb']:,} KB → "
                 f"{p['downsampled_rows']:,} rows / {p['downsampled_kb']:,} KB (**−{p['reduction_pct']}%**) |")
    return "\n".join(lines) + "\n"


def main():
    results = {"date": datetime.now().strftime("%Y-%m-%d %H:%M"), "machine": machine()}
    for name, module in [("fuzz", test_fuzz), ("outage", test_outage), ("restarts", test_restarts),
                         ("latency", test_latency), ("bench_api", bench_api)]:
        print(f"Running {name}...", flush=True)
        results[name] = module.run()

    (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    (HERE / "REPORT.md").write_text(report(results))
    print(report(results))


if __name__ == "__main__":
    main()
