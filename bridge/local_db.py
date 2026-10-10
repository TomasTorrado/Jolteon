"""
db.py: Part 3 of the pipeline (the SQLite safety net on the MacBook).

Job: store every clean reading in a local file BEFORE anything tries to upload it,
so a dead Wi-Fi connection or crashed uploader can never lose data.

A "clean reading" is a dict produced by Part 2 whose keys are the DB column names
from the data-structure contract (ts, seq, uptime_s, phase, t_hot_c, ...).
This file never renames or calculates anything. It only stores and retrieves.

Public functions:
    init_db()                  create the table if it doesn't exist
    save_reading(reading)      store one reading; returns True if new, False if duplicate
    get_unuploaded(limit)      rows not yet sent to Lakebase (oldest first)
    mark_uploaded(ids)         flag rows as sent after a SUCCESSFUL upload
    count_pending()            how many rows are still waiting to upload
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

# The database file lives next to this script (not wherever the terminal happens
# to be), so you always find the same readings.db no matter where you run from.
DEFAULT_DB_PATH = Path(__file__).parent / "readings.db"

# Column names, in the same order as the contract's Postgres table.
# These names are THE contract. If one changes, change the contract page first,
# then this list, then the CREATE TABLE below.
COLUMNS = [
    "ts",          # when the bridge received the reading (ISO 8601 UTC text)
    "seq",         # packet counter from the ESP32 (unique per reading)
    "uptime_s",    # seconds since the ESP32 booted
    "phase",       # 'charging' or 'discharging'
    "t_hot_c",     # hot plate temperature, deg C
    "t_cold_c",    # cold plate temperature, deg C
    "delta_t_c",   # t_hot_c - t_cold_c (calculated by the bridge)
    "gen_v",       # generator voltage, V
    "gen_ma",      # generator current, mA
    "gen_w",       # generator power, W (calculated by the bridge)
    "batt_v",      # battery voltage, V
    "batt_ma",     # battery current, mA (+ charging, - discharging)
    "batt_w",      # battery power, W (calculated by the bridge)
    "charge_mah",  # running total charge stored, mAh (from the ESP32)
    "energy_wh",   # running total energy stored, Wh (from the ESP32)
]

# Fields a reading MUST have. Everything else may be missing (stored as NULL).
REQUIRED = ["ts", "seq"]


@contextmanager
def _connect(db_path):
    """
    Open the database, hand it to the caller, then commit and close.

    - If the code inside the `with` block finishes normally, changes are committed.
    - If it raises an error, changes are rolled back (no half-written rows).
    - The connection is ALWAYS closed afterwards.
    Each function opens its own connection, so this is safe even if the uploader
    later runs in a different thread from the bridge.
    """
    conn = sqlite3.connect(db_path, timeout=10)   # wait up to 10 s if file is busy
    try:
        conn.row_factory = sqlite3.Row            # lets us read rows by column name
        # WAL mode: the bridge can write while the uploader reads, without blocking.
        conn.execute("PRAGMA journal_mode=WAL")
        # FULL = every commit is forced to disk. Slightly slower, but a pulled
        # plug or dead battery can't lose a reading we already said we saved.
        conn.execute("PRAGMA synchronous=FULL")
        with conn:                                # commit on success, rollback on error
            yield conn
    finally:
        conn.close()


def init_db(db_path=DEFAULT_DB_PATH):
    """Create the readings table if it doesn't exist. Safe to call every startup."""
    with _connect(db_path) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- local row number
                ts          TEXT    NOT NULL,                   -- ISO 8601 UTC text
                seq         INTEGER NOT NULL UNIQUE,            -- blocks duplicates
                uptime_s    INTEGER,
                phase       TEXT,
                t_hot_c     REAL,
                t_cold_c    REAL,
                delta_t_c   REAL,
                gen_v       REAL,
                gen_ma      REAL,
                gen_w       REAL,
                batt_v      REAL,
                batt_ma     REAL,
                batt_w      REAL,
                charge_mah  REAL,
                energy_wh   REAL,
                uploaded    INTEGER NOT NULL DEFAULT 0          -- 0 = waiting, 1 = in Lakebase
            )
        """)
        # Makes "find the oldest rows not yet uploaded" fast even with 100k+ rows.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_readings_uploaded ON readings (uploaded, id)"
        )
        # Makes "readings after time X" fast.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts)")


def save_reading(reading, db_path=DEFAULT_DB_PATH):
    """
    Store ONE clean reading.

    Returns:
        True  if the row was saved.
        False if a row with the same `seq` already exists (duplicate, ignored).

    Raises:
        ValueError if a required field is missing or the dict has a key that is
        not in the contract. Failing loudly on a typo like 'batt_vv' is deliberate:
        a silent NULL column would corrupt your charts without any error.
    """
    # 1) Reject keys that aren't in the contract (catches typos immediately).
    unknown = set(reading) - set(COLUMNS)
    if unknown:
        raise ValueError(f"Unknown field(s) not in the data contract: {sorted(unknown)}")

    # 2) Reject readings missing a required field.
    for name in REQUIRED:
        if reading.get(name) is None:
            raise ValueError(f"Reading is missing required field '{name}'")

    # 3) Build the parameters. Any optional field that is absent becomes None
    #    (stored as NULL). Values are passed as parameters, never pasted into
    #    the SQL text, so a weird value can't be run as SQL.
    params = {name: reading.get(name) for name in COLUMNS}

    column_list = ", ".join(COLUMNS)
    placeholder_list = ", ".join(f":{name}" for name in COLUMNS)

    with _connect(db_path) as conn:
        # INSERT OR IGNORE is SQLite's version of Postgres's ON CONFLICT DO NOTHING.
        cursor = conn.execute(
            f"INSERT OR IGNORE INTO readings ({column_list}) VALUES ({placeholder_list})",
            params,
        )
        # rowcount is 1 if a row was inserted, 0 if it was ignored as a duplicate.
        return cursor.rowcount == 1


def get_unuploaded(limit=200, db_path=DEFAULT_DB_PATH):
    """
    Return up to `limit` readings not yet uploaded, OLDEST FIRST.

    Each item is a dict with every contract column PLUS 'id' (the local row number).
    Part 4 needs the 'id' to call mark_uploaded() afterwards, and must NOT send 'id'
    to Lakebase (Postgres makes its own id).
    """
    column_list = ", ".join(["id"] + COLUMNS)
    with _connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT {column_list} FROM readings WHERE uploaded = 0 ORDER BY id LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def mark_uploaded(ids, db_path=DEFAULT_DB_PATH):
    """
    Flag rows as uploaded. Call this ONLY after Lakebase confirmed it stored them.
    If the upload failed, don't call it; the rows stay at 0 and get retried.
    `ids` is a list of local 'id' values from get_unuploaded().
    """
    if not ids:
        return
    marks = ", ".join("?" for _ in ids)   # one ? per id
    with _connect(db_path) as conn:
        conn.execute(f"UPDATE readings SET uploaded = 1 WHERE id IN ({marks})", list(ids))


def count_pending(db_path=DEFAULT_DB_PATH):
    """Number of readings still waiting to be uploaded (handy for log messages)."""
    with _connect(db_path) as conn:
        return conn.execute("SELECT COUNT(*) FROM readings WHERE uploaded = 0").fetchone()[0]