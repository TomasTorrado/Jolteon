"""Analyze the real long run: totals, power, ΔT, losses, data capture, reboots, and slide-ready charts.

Run from the repo root:
    python3 scripts/analyze_run.py                       # read through the API (default, localhost:8000)
    python3 scripts/analyze_run.py --source supabase     # read Supabase directly (publishable key)
    python3 scripts/analyze_run.py --source sqlite       # read the bridge's local file
    python3 scripts/analyze_run.py --actual-iphone-pct 38  # add the % we saw on demo day

Writes scripts/metrics/run_report.md, scripts/metrics/run_results.json and scripts/metrics/charts/*.png.
"""
import argparse
import json
import math
import os
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # draw straight to PNG files, no window
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "scripts" / "metrics"

IPHONE_WH = 13.7        # iPhone 16 battery capacity
BOOST_EFFICIENCY = 0.85  # 5 V USB boost module, battery -> phone
GAP_SECONDS = 60         # a pause longer than this counts as a gap in the data

# Chart colors (validated default palette: categorical slots 1-3 + text and grid tokens)
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
TEXT, TEXT_2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"


# ---------- loading ----------

def load_sqlite(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)  # read-only: never touch the bridge's file
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM readings ORDER BY ts, seq")]
    conn.close()
    return rows


def load_supabase():
    from dotenv import load_dotenv
    from supabase import create_client

    load_dotenv(ROOT / ".env")
    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_PUBLISHABLE_KEY"])
    rows, start = [], 0
    while True:  # Supabase returns at most 1000 rows per request, so page through
        page = client.table("readings").select("*").order("ts").order("seq").range(start, start + 999).execute().data
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


def load_api(url):
    # A huge max_points turns off the API's downsampling, so we get every row
    with urllib.request.urlopen(f"{url}/api/readings?max_points=100000000", timeout=120) as resp:
        return json.loads(resp.read())  # note: the API doesn't return uptime_s


def parse_ts(text):
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# ---------- analysis ----------

def mean(values):
    return sum(values) / len(values) if values else 0.0


def analyze(rows, actual_pct):
    first, last = rows[0], rows[-1]
    hours = (last["dt"] - first["dt"]).total_seconds() / 3600

    # Data capture: seq should go up by 1 per reading, so every missing number is a lost reading
    seqs = sorted({r["seq"] for r in rows})
    expected = seqs[-1] - seqs[0] + 1
    gaps = [
        {"from": a["ts"], "to": b["ts"], "minutes": round((b["dt"] - a["dt"]).total_seconds() / 60, 1)}
        for a, b in zip(rows, rows[1:])
        if (b["dt"] - a["dt"]).total_seconds() > GAP_SECONDS
    ]

    # Harvest stats use the charging phase only (while discharging, the battery feeds the phone)
    chg = [r for r in rows if r["phase"] == "charging"] or rows
    energy_wh = chg[-1]["energy_wh"]
    gen_w = [r["gen_w"] for r in chg]
    batt_w = [r["batt_w"] for r in chg]
    dts = [r["delta_t_c"] for r in chg if r["delta_t_c"] is not None]  # None = a temperature probe was missing
    losses = [(r["gen_w"] - r["batt_w"]) / r["gen_w"] for r in chg if r["gen_w"] > 0.001]

    # Reboots: uptime_s should only grow; a drop means the ESP32 restarted
    reboots = None
    if all(r.get("uptime_s") is not None for r in rows):
        reboots = sum(b["uptime_s"] < a["uptime_s"] for a, b in zip(rows, rows[1:]))

    predicted_pct = energy_wh * BOOST_EFFICIENCY / IPHONE_WH * 100
    return {
        "start": first["ts"],
        "end": last["ts"],
        "duration_hours": round(hours, 2),
        "readings": len(rows),
        "readings_charging": sum(r["phase"] == "charging" for r in rows),
        "readings_discharging": sum(r["phase"] == "discharging" for r in rows),
        "expected_seq_values": expected,
        "capture_rate_pct": round(100 * len(seqs) / expected, 2),
        "gaps_over_1_min": gaps,
        "energy_wh": round(energy_wh, 3),
        "charge_mah": round(chg[-1]["charge_mah"], 1),
        "gen_w_avg": round(mean(gen_w), 3),
        "gen_w_peak": round(max(gen_w), 3),
        "batt_w_avg": round(mean(batt_w), 3),
        "batt_w_peak": round(max(batt_w), 3),
        "delta_t_avg_c": round(mean(dts), 1),
        "delta_t_min_c": round(min(dts), 1),
        "delta_t_max_c": round(max(dts), 1),
        "gen_mw_per_c": round(1000 * mean(gen_w) / mean(dts), 2) if mean(dts) else 0,
        "conversion_loss_pct": round(100 * mean(losses), 1),
        "iphone_predicted_pct": round(predicted_pct, 1),
        "iphone_actual_pct": actual_pct,
        "esp32_reboots": reboots,
    }


# ---------- charts ----------

def style(ax, title, ylabel, pad=14):
    ax.set_title(title, loc="left", fontsize=20, color=TEXT, pad=pad)
    ax.set_xlabel("Hours since start", fontsize=15, color=TEXT_2)
    ax.set_ylabel(ylabel, fontsize=15, color=TEXT_2)
    ax.tick_params(labelsize=13, colors=TEXT_2, length=0)
    ax.grid(True, color=GRID, linewidth=1)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)


def binned(rows, key, minutes=5):
    """Average `key` over 5-minute bins; an empty bin becomes NaN so the line breaks at data gaps."""
    t0, size = rows[0]["dt"], minutes * 60
    bins = {}
    for r in rows:
        if r[key] is not None:  # skip readings where this value is missing (e.g. a probe was unplugged)
            bins.setdefault(int((r["dt"] - t0).total_seconds() // size), []).append(r[key])
    xs = range(max(bins) + 1)
    return [(i + 0.5) * size / 3600 for i in xs], [mean(bins[i]) if i in bins else math.nan for i in xs]


def line_chart(rows, series, title, ylabel, path, label_ends=True):
    fig, ax = plt.subplots(figsize=(12, 6.75), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    for key, label, color in series:
        x, y = binned(rows, key)
        ax.plot(x, y, color=color, linewidth=2, label=label)
        if label_ends and len(series) > 1:  # direct label at the end of each line
            last = next(v for v in reversed(y) if not math.isnan(v))
            ax.annotate(label, (x[-1], last), xytext=(8, 0), textcoords="offset points",
                        va="center", fontsize=13, color=TEXT)
    style(ax, title, ylabel, pad=40 if len(series) > 1 else 14)
    if len(series) > 1:  # legend in one row between the title and the plot, clear of the lines
        ax.legend(frameon=False, fontsize=13, loc="lower left", bbox_to_anchor=(0, 1.0), ncol=len(series),
                  labelcolor=TEXT, borderaxespad=0.3, handlelength=1.5)
        ax.margins(x=0.08)  # room for the end labels
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def make_charts(rows, out):
    out.mkdir(parents=True, exist_ok=True)
    chg = [r for r in rows if r["phase"] == "charging"] or rows
    line_chart(rows, [("energy_wh", "Energy stored", BLUE)],
               "Energy stored in the battery (5-min average)", "Energy (Wh)", out / "energy.png")
    line_chart(chg, [("gen_w", "Generator", BLUE), ("batt_w", "Into battery", ORANGE)],
               "Power while charging: generators vs. into the battery (5-min avg)", "Power (W)", out / "power.png")
    line_chart(rows, [("t_cold_c", "Cold plate", BLUE), ("t_hot_c", "Hot plate", ORANGE), ("delta_t_c", "ΔT", AQUA)],
               "Plate temperatures and ΔT (5-min average)", "Temperature (°C)", out / "temperatures.png")

    fig, ax = plt.subplots(figsize=(12, 6.75), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    pts = [r for r in chg if r["delta_t_c"] is not None]
    ax.scatter([r["delta_t_c"] for r in pts], [r["gen_w"] for r in pts], s=10, color=BLUE, alpha=0.35, linewidths=0)
    style(ax, "Generator power vs. ΔT (every charging reading)", "Generator power (W)")
    ax.set_xlabel("ΔT, hot minus cold plate (°C)", fontsize=15, color=TEXT_2)
    fig.tight_layout()
    fig.savefig(out / "power_vs_delta_t.png", dpi=150)
    plt.close(fig)
    return ["energy.png", "power.png", "temperatures.png", "power_vs_delta_t.png"]


# ---------- report ----------

def write_report(res, charts, source, path):
    actual = res["iphone_actual_pct"]
    gaps = res["gaps_over_1_min"]
    lines = [
        "# Long-run report",
        "",
        f"Source: {source} · {res['start']} → {res['end']}",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Run duration | {res['duration_hours']} h |",
        f"| Readings | {res['readings']:,} ({res['readings_charging']:,} charging, {res['readings_discharging']:,} discharging) |",
        f"| Data capture | {res['capture_rate_pct']}% of {res['expected_seq_values']:,} expected seq values |",
        f"| Gaps > 1 min | {len(gaps)} |",
        f"| Energy harvested | **{res['energy_wh']} Wh** |",
        f"| Charge stored | {res['charge_mah']} mAh |",
        f"| Generator power | avg {res['gen_w_avg']} W · peak {res['gen_w_peak']} W |",
        f"| Power into battery | avg {res['batt_w_avg']} W · peak {res['batt_w_peak']} W |",
        f"| ΔT | avg {res['delta_t_avg_c']} °C · min {res['delta_t_min_c']} °C · max {res['delta_t_max_c']} °C |",
        f"| Generator power per °C of ΔT | {res['gen_mw_per_c']} mW/°C (avg power ÷ avg ΔT) |",
        f"| Conversion losses (generator → battery) | {res['conversion_loss_pct']}% |",
        f"| iPhone 16 charge, predicted | **{res['iphone_predicted_pct']}%** ({res['energy_wh']} Wh × {BOOST_EFFICIENCY} ÷ {IPHONE_WH} Wh) |",
        f"| iPhone 16 charge, observed on demo day | {f'**{actual}%**' if actual is not None else 'not entered yet (--actual-iphone-pct)'} |",
        f"| ESP32 reboots | {res['esp32_reboots'] if res['esp32_reboots'] is not None else 'n/a (the API does not return uptime_s; use --source supabase or sqlite)'} |",
    ]
    if gaps:
        lines += ["", "## Gaps longer than 1 minute", "", "| From | To | Minutes |", "|---|---|---|"]
        lines += [f"| {g['from']} | {g['to']} | {g['minutes']} |" for g in gaps]
    lines += ["", "## Charts", ""] + [f"![{c}](charts/{c})" for c in charts]
    path.write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["api", "supabase", "sqlite"], default="api")
    parser.add_argument("--api-url", default="http://localhost:8000")
    parser.add_argument("--db", default=str(ROOT / "bridge" / "readings.db"), help="SQLite file for --source sqlite")
    parser.add_argument("--actual-iphone-pct", type=float, help="iPhone charge %% we observed on demo day")
    parser.add_argument("--out", default=str(OUT_DIR), help="folder for the report, JSON and charts")
    args = parser.parse_args()

    if args.source == "sqlite":
        rows = load_sqlite(args.db)
    elif args.source == "supabase":
        rows = load_supabase()
    else:
        rows = load_api(args.api_url)
    if len(rows) < 2:
        raise SystemExit(f"Need at least 2 readings to analyze, found {len(rows)}.")
    for r in rows:
        r["dt"] = parse_ts(r["ts"])
    rows.sort(key=lambda r: (r["dt"], r["seq"]))

    out = Path(args.out)
    results = analyze(rows, args.actual_iphone_pct)
    charts = make_charts(rows, out / "charts")
    (out / "run_results.json").write_text(json.dumps({"source": args.source, **results}, indent=2) + "\n")
    write_report(results, charts, args.source, out / "run_report.md")
    print((out / "run_report.md").read_text())


if __name__ == "__main__":
    main()
