"""Fake ESP32: prints one JSON reading per line, like the real board over USB serial."""
import argparse
import json
import random
import time


def drift(value, low, high, step):
    """Nudge value by a small random amount, kept inside [low, high]."""
    return min(high, max(low, value + random.uniform(-step, step)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=float, default=10, help="seconds between lines")
    parser.add_argument("--bad-lines", action="store_true", help="sometimes print a broken line")
    parser.add_argument("--reboot-every", type=int, default=0, help="simulate an ESP32 reboot every N lines")
    args = parser.parse_args()

    # Starting values (middle of each range)
    th, tc = 52.0, 4.0
    gv, gi = 4.25, 75.0
    bv, bi = 4.05, 75.0
    mah, wh = 0.0, 0.0
    seq, up = 0, 0
    count = 0  # lines printed so far

    while True:
        # Simulated reboot: boot message, uptime restarts, seq resumes 6 ahead (totals survive, like the firmware)
        if args.reboot_every and count and count % args.reboot_every == 0:
            print("# boot (simulated reboot)", flush=True)
            up, seq = 0, seq + 6
        count += 1
        th = drift(th, 45, 60, 0.5)
        tc = drift(tc, 1, 8, 0.3)
        gv = drift(gv, 4.0, 4.5, 0.03)
        gi = drift(gi, 60, 90, 2)
        bv = drift(bv, 3.9, 4.2, 0.02)
        bi = drift(bi, 60, 90, 2)

        # Add the charge and energy stored during this interval
        hours = args.interval / 3600
        mah += bi * hours
        wh += bv * (bi / 1000) * hours

        line = {
            "seq": seq, "up": round(up), "ph": "chg",
            "th": round(th, 1), "tc": round(tc, 1),
            "gv": round(gv, 2), "gi": round(gi, 1),
            "bv": round(bv, 2), "bi": round(bi, 1),
            "mah": round(mah, 1), "wh": round(wh, 2),
        }
        text = json.dumps(line, separators=(",", ":"))
        if args.bad_lines and random.random() < 0.2:
            # Break ~1 in 5 lines: cut it off, rename a key, or make gv non-numeric
            text = random.choice([text[:25], text.replace('"bi"', '"xx"'), text.replace('"gv":', '"gv":"?","_":')])
        print(text, flush=True)

        seq += 1
        up += args.interval
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass  # Ctrl+C: exit quietly, no traceback
