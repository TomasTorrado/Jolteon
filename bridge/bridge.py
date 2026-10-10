"""Bridge: read ESP32 serial lines, validate them, save them to SQLite, and upload them to Supabase."""
import argparse
import json
import logging
import math
import sys
import time
from datetime import datetime, timezone

import local_db as db
from contract import KEY_MAP, PHASE_MAP, RANGES, REQUIRED_KEYS
from uploader import make_client, upload_pending

# Warnings go to stderr, so stdout only carries one status line per reading
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("bridge")


def is_number(value):
    """True for real, finite numbers: excludes bools (Python counts them as ints) and NaN/Infinity."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def process_line(line):
    """Turn one raw serial line into a clean reading dict, or None if it's unusable."""
    line = line.strip()
    if not line:
        return None

    try:
        raw = json.loads(line)
    except json.JSONDecodeError:
        log.warning("bad JSON, skipped: %r", line)
        return None
    if not isinstance(raw, dict):
        log.warning("not a JSON object, skipped: %r", line)
        return None

    # Every key must be present, and every key except "ph" must be a finite number
    missing = [k for k in REQUIRED_KEYS if k not in raw]
    invalid = [k for k in REQUIRED_KEYS if k in raw and k != "ph" and not is_number(raw[k])]
    if missing or invalid:
        log.warning("missing %s / not a valid number %s, skipped: %r", missing, invalid, line)
        return None

    # Rename keys and expand the phase code (unknown codes pass through unchanged)
    reading = {KEY_MAP[k]: raw[k] for k in REQUIRED_KEYS}
    reading["phase"] = PHASE_MAP.get(raw["ph"], raw["ph"])
    reading["ts"] = datetime.now(timezone.utc).isoformat()

    # Derived fields: power in watts (V * mA / 1000) and plate temperature difference
    reading["gen_w"] = round(reading["gen_v"] * reading["gen_ma"] / 1000, 3)
    reading["batt_w"] = round(reading["batt_v"] * reading["batt_ma"] / 1000, 3)
    reading["delta_t_c"] = round(reading["t_hot_c"] - reading["t_cold_c"], 3)

    # Out-of-range values are suspicious but kept: real sensors can be odd
    for field, (low, high) in RANGES.items():
        if not low <= reading[field] <= high:
            log.warning("seq %s: %s=%s outside %s..%s", reading["seq"], field, reading[field], low, high)

    return reading


def read_lines(args):
    """Yield text lines from the serial port if --port was given, otherwise from stdin."""
    if args.port:
        import serial  # pyserial, only needed with a real board

        # Outer loop: (re)open the port, so an unplugged cable doesn't end a long run
        while True:
            try:
                # Create the port without opening it, so we can set DTR/RTS first.
                # These two lines trigger the ESP32's auto-reset; keeping them off means
                # opening the port doesn't reboot the board (and restart seq at 0).
                port = serial.Serial(baudrate=args.baud, timeout=1)
                port.port = args.port
                port.dtr = False
                port.rts = False
                port.open()
                with port:
                    log.info("connected to %s", args.port)
                    while True:
                        data = port.readline()  # b"" if nothing arrived within the timeout
                        if data:
                            yield data.decode("utf-8", errors="replace")
            except serial.SerialException as e:
                log.warning("serial error (%s), retrying in 3 s", e)
                time.sleep(3)
    else:
        yield from sys.stdin


def upload_backlog(client):
    """Upload batches until nothing is pending or an upload fails. Never raises, so the bridge keeps reading."""
    total = 0
    try:
        while (count := upload_pending(client)) > 0:
            total += count
    except Exception as e:  # e.g. a SQLite error inside the uploader
        log.warning("uploader error: %s", e)
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", help="serial port, e.g. /dev/cu.usbserial-0001 (default: read stdin)")
    parser.add_argument("--baud", type=int, default=115200, help="serial baud rate")
    parser.add_argument("--no-upload", action="store_true", help="only save to SQLite (offline testing)")
    args = parser.parse_args()

    db.init_db()
    client = None if args.no_upload else make_client()

    good = bad = uploaded = 0
    try:
        for line in read_lines(args):
            if not line.strip():
                continue  # empty lines are neither good nor bad
            reading = process_line(line)
            if reading is None:
                bad += 1
                continue
            good += 1

            # Save locally first, so the reading is safe even if the upload fails
            status = "saved" if db.save_reading(reading) else "duplicate"  # duplicate = seq already in SQLite
            if client:
                uploaded += upload_backlog(client)
            print(f"{status} seq={reading['seq']}  energy={reading['energy_wh']:.3f} Wh"
                  f"  uploaded={uploaded}  pending={db.count_pending()}", flush=True)
    except KeyboardInterrupt:
        pass
    print(f"\nStopped. good={good} bad={bad}", file=sys.stderr)


if __name__ == "__main__":
    main()
