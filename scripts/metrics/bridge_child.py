"""Bridge stand-in for test_restarts.py: the bridge's loop (validate, save, upload) on the TEST database.

bridge.py always uses bridge/readings.db, so this runs the same steps against metrics_test.db instead.
Prints "saved <seq>" after each reading is safely in SQLite, so the parent knows what got through.
"""
import sys

import common
from common import drain, make_client, process_line

client = make_client()
for line in sys.stdin:
    reading = process_line(line)
    if reading is None:
        continue
    common.db.save_reading(reading, common.TEST_DB)  # save first (a duplicate seq is ignored)
    print(f"saved {reading['seq']}", flush=True)
    drain(client)  # then upload the backlog, exactly like the bridge
