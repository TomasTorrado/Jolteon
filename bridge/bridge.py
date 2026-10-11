"""Bridge: read ESP32 serial lines, validate them, save them to SQLite, and upload them to Supabase.

Input: lines piped into stdin (e.g. from fake_esp32.py), otherwise the ESP32's USB serial port,
found automatically (or given with --port). The serial connection survives unplugs and reboots.
"""
import argparse
import json
import logging
import math
import os
import sys
import time
from datetime import datetime, timezone

import local_db as db
from contract import KEY_MAP, LOG_PREFIX, NULLABLE_KEYS, PHASE_MAP, RANGES, REQUIRED_KEYS
from uploader import make_client, upload_pending

# Warnings go to stderr, so stdout only carries one status line per reading
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("bridge")

# Device-name fragments of USB-serial chips used on ESP32 boards (CP210x = SLAB, CH340 = wchusbserial)
PORT_PATTERNS = ("usbserial", "usbmodem", "SLAB", "wchusbserial")
RETRY_SECONDS = 3


class Stats:
    """Counters for the status line and the Ctrl+C summary (the metrics suite will use them later)."""

    def __init__(self):
        self.good = self.bad = self.uploaded = 0
        self.reconnects = self.reboots = self.seq_gaps = self.skipped_seq = 0
        self.last_seq = self.last_up = None   # from the previous valid reading
        self.last_valid = time.monotonic()     # when the last valid reading arrived (for the watchdog)


def stamp():
    """Local time as HH:MM:SS, for messages you'll read back after a long run."""
    return datetime.now().strftime("%H:%M:%S")


def fmt_temp(celsius):
    """A probe temperature for the status line; '--' when the probe sent null."""
    return "--" if celsius is None else f"{celsius:.1f}C"


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

    # Every key must be present; every key except "ph" must be a finite number (th/tc may also be null)
    missing = [k for k in REQUIRED_KEYS if k not in raw]
    invalid = [k for k in REQUIRED_KEYS if k in raw and k != "ph" and not is_number(raw[k])
               and not (k in NULLABLE_KEYS and raw[k] is None)]
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
    if reading["t_hot_c"] is None or reading["t_cold_c"] is None:
        reading["delta_t_c"] = None  # can't compute ΔT without both probes
        log.warning("seq %s: temperature probe missing (th=%s, tc=%s), delta_t_c not computed",
                    reading["seq"], raw["th"], raw["tc"])
    else:
        reading["delta_t_c"] = round(reading["t_hot_c"] - reading["t_cold_c"], 3)

    # Out-of-range values are suspicious but kept: real sensors can be odd
    for field, (low, high) in RANGES.items():
        if reading[field] is not None and not low <= reading[field] <= high:
            log.warning("seq %s: %s=%s outside %s..%s", reading["seq"], field, reading[field], low, high)

    return reading


def check_sequence(reading, stats):
    """Compare seq and uptime with the previous reading: log seq gaps, seq going backward, and ESP32 reboots."""
    seq, up = reading["seq"], reading["uptime_s"]
    if stats.last_seq is not None:
        if seq < stats.last_seq:
            log.warning("%s !!! seq went backward from %s to %s. New readings may be dropped as duplicates. "
                        "Clear the readings table before the real run.", stamp(), stats.last_seq, seq)
        elif seq > stats.last_seq + 1:  # normal after a reboot: the firmware resumes seq a little ahead
            stats.seq_gaps += 1
            stats.skipped_seq += seq - stats.last_seq - 1
            log.info("%s gap of %s readings (seq %s -> %s)", stamp(), seq - stats.last_seq - 1, stats.last_seq, seq)
    if stats.last_up is not None and up < stats.last_up:  # uptime only drops when the ESP32 restarts
        stats.reboots += 1
        log.info("%s ESP32 reboot #%s detected (uptime %s s -> %s s)", stamp(), stats.reboots, stats.last_up, up)
    stats.last_seq, stats.last_up = seq, up


def find_port(preferred=None):
    """Return `preferred` if it exists, otherwise the first port that looks like an ESP32, or None."""
    from serial.tools import list_ports

    if preferred and os.path.exists(preferred):  # --port given and currently plugged in
        return preferred
    devices = sorted(p.device for p in list_ports.comports())
    return next((d for d in devices if any(pattern in d for pattern in PORT_PATTERNS)), None)


def list_ports_and_exit():
    from serial.tools import list_ports

    for p in sorted(list_ports.comports(), key=lambda p: p.device):
        mark = "  <- looks like an ESP32" if any(pattern in p.device for pattern in PORT_PATTERNS) else ""
        print(f"{p.device}  ({p.description}){mark}")
    sys.exit(0)


def upload_backlog(client):
    """Upload batches until nothing is pending or an upload fails. Never raises, so the bridge keeps reading."""
    total = 0
    try:
        while (count := upload_pending(client)) > 0:
            total += count
    except Exception as e:  # e.g. a SQLite error inside the uploader
        log.warning("uploader error: %s", e)
    return total


def wait_for_retry(client, stats):
    """Pause between reconnect attempts, but keep uploading pending rows meanwhile."""
    if client:
        stats.uploaded += upload_backlog(client)
    time.sleep(RETRY_SECONDS)


def read_serial(args, stats, client):
    """Yield lines from the ESP32 forever: (re)find and (re)open the port after unplugs, errors and silence."""
    import serial  # pyserial, only needed with a real board

    connected_once = False
    last_wait_msg = 0
    while True:
        device = find_port(args.port)  # --port if it exists, otherwise auto-detect
        if device is None:
            if time.monotonic() - last_wait_msg > 60:  # say it once a minute, not every 3 s
                log.warning("%s waiting for the ESP32 (no USB serial port found), retrying every %s s",
                            stamp(), RETRY_SECONDS)
                last_wait_msg = time.monotonic()
            wait_for_retry(client, stats)
            continue

        # Opening the port resets the ESP32 on our board (the firmware resumes seq and totals from flash).
        # DTR/RTS off avoids that reset on boards where it works; it's harmless where it doesn't.
        port = serial.Serial(baudrate=args.baud, timeout=1)  # 1 s read timeout, so the watchdog can check
        port.port, port.dtr, port.rts = device, False, False
        try:
            port.open()
            if connected_once:
                stats.reconnects += 1
            connected_once, last_wait_msg = True, 0
            log.info("%s connected to %s%s", stamp(), device, " (reconnected)" if stats.reconnects else "")
            stats.last_valid = time.monotonic()
            while True:
                data = port.readline()  # b"" if nothing arrived within the 1 s timeout
                if data:
                    yield data.decode("utf-8", errors="replace")
                # Watchdog: no valid reading for too long -> reopen the port (this also resets a frozen ESP32)
                if time.monotonic() - stats.last_valid > args.watchdog:
                    log.warning("%s no valid reading for %s s, reopening %s", stamp(), args.watchdog, device)
                    break
        except (serial.SerialException, OSError) as e:  # cable unplugged, port busy, ...
            log.warning("%s serial error on %s (%s), retrying in %s s", stamp(), device, e, RETRY_SECONDS)
            wait_for_retry(client, stats)
        finally:
            port.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", help="preferred serial port, e.g. /dev/cu.usbserial-0001 (default: auto-detect)")
    parser.add_argument("--baud", type=int, default=115200, help="serial baud rate")
    parser.add_argument("--watchdog", type=int, default=60, help="reopen the port after this many seconds without a valid reading")
    parser.add_argument("--list-ports", action="store_true", help="print all serial ports and exit")
    parser.add_argument("--no-upload", action="store_true", help="only save to SQLite (offline testing)")
    args = parser.parse_args()
    if args.list_ports:
        list_ports_and_exit()

    db.init_db()
    client = None if args.no_upload else make_client()
    stats = Stats()

    # Piped input (e.g. fake_esp32.py | bridge.py) reads stdin exactly as before; otherwise use the serial port
    use_serial = args.port or sys.stdin.isatty()
    lines = read_serial(args, stats, client) if use_serial else sys.stdin

    try:
        for line in lines:
            if not line.strip():
                continue  # empty lines are neither good nor bad
            if line.lstrip().startswith(LOG_PREFIX):  # a message from the ESP32, not a reading
                print(f"{stamp()} [esp32] {line.strip()}", file=sys.stderr, flush=True)
                continue
            reading = process_line(line)
            if reading is None:
                stats.bad += 1
                continue
            stats.good += 1
            stats.last_valid = time.monotonic()
            check_sequence(reading, stats)

            # Save locally first, so the reading is safe even if the upload fails
            status = "saved" if db.save_reading(reading) else "duplicate"  # duplicate = seq already in SQLite
            if client:
                stats.uploaded += upload_backlog(client)
            print(f"{status} seq={reading['seq']}  hot={fmt_temp(reading.get('t_hot_c'))}"
                  f"  cold={fmt_temp(reading.get('t_cold_c'))}  energy={reading['energy_wh']:.3f} Wh"
                  f"  uploaded={stats.uploaded}  pending={db.count_pending()}"
                  f"  reconnects={stats.reconnects}  reboots={stats.reboots}  gaps={stats.seq_gaps}", flush=True)
    except KeyboardInterrupt:
        pass
    print(f"\nStopped. good={stats.good} bad={stats.bad}  reconnects={stats.reconnects}  "
          f"reboots={stats.reboots}  seq_gaps={stats.seq_gaps} (skipped {stats.skipped_seq} seq values)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
