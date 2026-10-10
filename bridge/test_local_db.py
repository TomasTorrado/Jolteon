"""
test_db.py: checks db.py using values from the data-structure contract.
Uses its OWN temporary file, so it never touches your real readings.db.
"""

from pathlib import Path
import local_db as db

TEST_DB = Path(__file__).parent / "test_readings.db"

# Start from a clean slate. Delete leftovers from a previous test run.
for suffix in ("", "-wal", "-shm"):
    Path(str(TEST_DB) + suffix).unlink(missing_ok=True)

# The example line from the contract, already cleaned by "Part 2":
#   {"seq":4182,"up":41820,"ph":"chg","th":52.4,"tc":3.1,"gv":4.31,"gi":82.0,
#    "bv":4.05,"bi":74.5,"mah":1830.2,"wh":7.41}
# gen_w  = 4.31 * 82.0 / 1000 = 0.353   (matches the contract's API example)
# batt_w = 4.05 * 74.5 / 1000 = 0.302
def make_reading(seq, **overrides):
    reading = {
        "ts": "2026-10-10T14:32:10Z",
        "seq": seq,
        "uptime_s": 41820 + (seq - 4182) * 10,
        "phase": "charging",
        "t_hot_c": 52.4, "t_cold_c": 3.1, "delta_t_c": 49.3,
        "gen_v": 4.31, "gen_ma": 82.0, "gen_w": 0.353,
        "batt_v": 4.05, "batt_ma": 74.5, "batt_w": 0.302,
        "charge_mah": 1830.2, "energy_wh": 7.41,
    }
    reading.update(overrides)
    return reading

# --- Test 1: creating the table twice must not break anything ---
db.init_db(TEST_DB)
db.init_db(TEST_DB)
print("1. init_db is safe to call twice: OK")

# --- Test 2: save 5 readings (seq 4182..4186) ---
for seq in range(4182, 4187):
    assert db.save_reading(make_reading(seq), TEST_DB) is True
print("2. Saved 5 readings: OK")

# --- Test 3: a duplicate seq must be ignored, not stored twice ---
assert db.save_reading(make_reading(4184), TEST_DB) is False
assert db.count_pending(TEST_DB) == 5
print("3. Duplicate seq ignored, still 5 rows: OK")

# --- Test 4: a discharging reading with NEGATIVE battery current is stored as-is ---
discharge = make_reading(4187, phase="discharging", batt_ma=-310.0, batt_w=-1.2555)
assert db.save_reading(discharge, TEST_DB) is True
print("4. Discharging row with negative current: OK")

# --- Test 5: bad input must fail loudly ---
try:
    db.save_reading({"seq": 9999}, TEST_DB)               # missing 'ts'
    raise SystemExit("FAIL: missing ts was accepted")
except ValueError:
    pass
try:
    db.save_reading(make_reading(9998, batt_vv=4.0), TEST_DB)   # typo'd field name
    raise SystemExit("FAIL: unknown field was accepted")
except ValueError:
    pass
print("5. Missing/unknown fields rejected: OK")

# --- Test 6: stored values come back exactly, in order ---
pending = db.get_unuploaded(limit=200, db_path=TEST_DB)
assert len(pending) == 6
assert [r["seq"] for r in pending] == [4182, 4183, 4184, 4185, 4186, 4187]
first = pending[0]
assert first["phase"] == "charging" and first["gen_w"] == 0.353 and first["energy_wh"] == 7.41
assert pending[-1]["batt_ma"] == -310.0
print("6. Values and order round-trip correctly: OK")

# --- Test 7: limit works ---
assert len(db.get_unuploaded(limit=2, db_path=TEST_DB)) == 2
print("7. limit respected: OK")

# --- Test 8: marking uploaded removes rows from the pending list ---
db.mark_uploaded([r["id"] for r in pending[:3]], TEST_DB)
assert db.count_pending(TEST_DB) == 3
assert [r["seq"] for r in db.get_unuploaded(db_path=TEST_DB)] == [4185, 4186, 4187]
print("8. mark_uploaded works (3 left pending): OK")

# --- Test 9: marking an empty list does nothing and doesn't crash ---
db.mark_uploaded([], TEST_DB)
assert db.count_pending(TEST_DB) == 3
print("9. mark_uploaded([]) is harmless: OK")

print("\nAll Part 3 tests passed.")