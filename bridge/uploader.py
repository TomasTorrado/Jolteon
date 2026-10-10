"""Uploader: send readings waiting in local SQLite to Supabase, then mark them uploaded."""
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from supabase import ClientOptions, create_client

import local_db as db

# Load .env from the repo root (one folder up from bridge/)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
log = logging.getLogger("uploader")
logging.getLogger("httpx").setLevel(logging.WARNING)  # hide the "HTTP Request: POST ..." line per upload


def make_client():
    """Create a Supabase client from .env, or exit with a clear error if the keys are missing."""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY")
    if not url or not key:
        sys.exit("Error: SUPABASE_URL or SUPABASE_SECRET_KEY not set. Create .env in the repo root (see .env.example).")
    # Give up on a request after 10 s (default is 120 s), so a dead Wi-Fi can't stall the bridge for long
    return create_client(url, key, options=ClientOptions(postgrest_client_timeout=10))


def upload_pending(client, db_path=db.DEFAULT_DB_PATH, batch_size=100):
    """Upload up to batch_size pending rows (oldest first). Returns how many were uploaded (0 on failure)."""
    pending = db.get_unuploaded(batch_size, db_path)
    if not pending:
        return 0

    # Send only the contract columns: no local id, no uploaded flag. ts is already ISO 8601 text.
    rows = [{name: row[name] for name in db.COLUMNS} for row in pending]

    try:
        # One request for the whole batch. A seq already in Supabase is skipped, not duplicated.
        client.table("readings").upsert(rows, on_conflict="seq", ignore_duplicates=True).execute()
    except Exception as e:
        log.warning("upload failed, %d rows will retry later: %s", len(rows), e)
        return 0

    # Only reached if Supabase accepted the batch
    db.mark_uploaded([row["id"] for row in pending], db_path)
    return len(rows)
