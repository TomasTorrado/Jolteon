"""Test the Supabase connection: insert a test row, keep inserting (--soak), or delete test rows (--cleanup)."""
import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

# Load .env from the repo root (one folder up from scripts/)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

TEST_SEQ = 900000  # test rows use seq >= this, so --cleanup can find them


def insert_row(client, seq):
    """Insert one test row, then return its timestamp and the table's row count."""
    ts = datetime.now(timezone.utc).isoformat()
    client.table("readings").insert({"ts": ts, "seq": seq, "energy_wh": 0.0}).execute()
    count = client.table("readings").select("*", count="exact", head=True).execute().count
    return ts, count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--soak", action="store_true", help="insert a row every 10 s until Ctrl+C")
    parser.add_argument("--cleanup", action="store_true", help="delete all test rows (seq >= 900000)")
    args = parser.parse_args()

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY")
    if not url or not key:
        sys.exit("Error: SUPABASE_URL or SUPABASE_SECRET_KEY not set. Create .env in the repo root (see .env.example).")
    client = create_client(url, key)

    if args.cleanup:
        try:
            res = client.table("readings").delete(count="exact").gte("seq", TEST_SEQ).execute()
            print(f"Deleted {res.count} test rows.")
        except Exception as e:
            sys.exit(f"Supabase error: {e}")
        return

    if not args.soak:
        try:
            ts, count = insert_row(client, TEST_SEQ)
            print(f"{ts}  seq={TEST_SEQ}  rows={count}")
        except Exception as e:
            sys.exit(f"Supabase error: {e}")
        return

    # Soak mode: keep going through errors (e.g. Wi-Fi drops) until Ctrl+C
    seq = TEST_SEQ
    try:
        while True:
            try:
                ts, count = insert_row(client, seq)
                print(f"{ts}  seq={seq}  rows={count}")
                seq += 1
            except Exception as e:
                print(f"Insert failed (seq={seq}), will retry: {e}")
            time.sleep(10)
    except KeyboardInterrupt:
        print("\nStopped soak test.")


if __name__ == "__main__":
    main()
