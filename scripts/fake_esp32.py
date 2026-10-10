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
    args = parser.parse_args()

    # Starting values (middle of each range)
    th, tc = 52.0, 4.0
    gv, gi = 4.25, 75.0
    bv, bi = 4.05, 75.0
    mah, wh = 0.0, 0.0
    seq, up = 0, 0

    while True:
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
        print(json.dumps(line, separators=(",", ":")), flush=True)

        seq += 1
        up += args.interval
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
