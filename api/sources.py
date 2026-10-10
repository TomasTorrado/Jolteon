"""Data sources for the API: read readings from Supabase (default) or the bridge's local SQLite file.

Both sources have the same four methods, so main.py doesn't care which one it's using:
    latest()         newest reading (by ts), or None
    first()          oldest reading (by ts), or None
    count()          number of readings
    readings(since)  all readings with ts after `since` (or all if None), oldest first
"""
import os
import sqlite3

from supabase import ClientOptions, create_client

from bridge.local_db import COLUMNS, DEFAULT_DB_PATH

# Fields the API returns: every contract column except uptime_s (the dashboard doesn't need it)
FIELDS = [c for c in COLUMNS if c != "uptime_s"]

PAGE_SIZE = 1000  # Supabase returns at most 1000 rows per request


class SupabaseSource:
    name = "supabase"

    def __init__(self):
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_PUBLISHABLE_KEY")  # read-only key; never the secret key here
        if not url or not key:
            raise RuntimeError("SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY not set in .env (see .env.example)")
        # Fail a request after 10 s instead of hanging (default is 120 s)
        self.client = create_client(url, key, options=ClientOptions(postgrest_client_timeout=10))

    def _table(self):
        return self.client.table("readings")

    def latest(self):
        rows = self._table().select(",".join(FIELDS)).order("ts", desc=True).limit(1).execute().data
        return rows[0] if rows else None

    def first(self):
        rows = self._table().select(",".join(FIELDS)).order("ts").limit(1).execute().data
        return rows[0] if rows else None

    def count(self):
        # head=True: ask only for the count, not the rows themselves
        return self._table().select("seq", count="exact", head=True).execute().count

    def readings(self, since=None):
        # Page through the results 1000 rows at a time until a page comes back short
        rows, start = [], 0
        while True:
            query = self._table().select(",".join(FIELDS)).order("ts").order("seq")
            if since:
                query = query.gt("ts", since)
            page = query.range(start, start + PAGE_SIZE - 1).execute().data  # range is inclusive
            rows += page
            if len(page) < PAGE_SIZE:
                return rows
            start += PAGE_SIZE


class SqliteSource:
    name = "sqlite"

    def __init__(self):
        self.path = os.getenv("SQLITE_PATH") or str(DEFAULT_DB_PATH)

    def _query(self, sql, params=()):
        # Open read-only (mode=ro): the API must never write to the bridge's file
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=10)
        try:
            conn.row_factory = sqlite3.Row  # rows can be turned into dicts by column name
            return [dict(row) for row in conn.execute(sql, params)]
        finally:
            conn.close()

    def latest(self):
        rows = self._query(f"SELECT {', '.join(FIELDS)} FROM readings ORDER BY ts DESC LIMIT 1")
        return rows[0] if rows else None

    def first(self):
        rows = self._query(f"SELECT {', '.join(FIELDS)} FROM readings ORDER BY ts LIMIT 1")
        return rows[0] if rows else None

    def count(self):
        return self._query("SELECT COUNT(*) AS n FROM readings")[0]["n"]

    def readings(self, since=None):
        sql = f"SELECT {', '.join(FIELDS)} FROM readings"
        if since:
            # ts is stored as ISO 8601 UTC text, which sorts and compares correctly as a string
            return self._query(sql + " WHERE ts > ? ORDER BY ts, seq", (since,))
        return self._query(sql + " ORDER BY ts, seq")


def make_source():
    """Pick the data source from DATA_SOURCE in .env ("supabase" by default, or "sqlite")."""
    choice = os.getenv("DATA_SOURCE", "supabase").strip().lower()
    if choice == "sqlite":
        return SqliteSource()
    if choice == "supabase":
        return SupabaseSource()
    raise RuntimeError(f'DATA_SOURCE must be "supabase" or "sqlite", got "{choice}"')
