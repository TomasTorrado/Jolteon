"""The data contract: what the ESP32 sends and what the bridge turns it into."""

# Serial key -> clean field name
KEY_MAP = {
    "seq": "seq",
    "up": "uptime_s",
    "ph": "phase",
    "th": "t_hot_c",
    "tc": "t_cold_c",
    "gv": "gen_v",
    "gi": "gen_ma",
    "bv": "batt_v",
    "bi": "batt_ma",
    "mah": "charge_mah",
    "wh": "energy_wh",
}

# Short phase code -> readable phase
PHASE_MAP = {"chg": "charging", "dis": "discharging"}

# Every serial line must have all of these keys
REQUIRED_KEYS = list(KEY_MAP)

# Expected (min, max) per clean field; values outside only trigger a warning
RANGES = {
    "t_hot_c": (0, 90),
    "t_cold_c": (-5, 40),
    "gen_v": (0, 10),
    "gen_ma": (-50, 500),
    "batt_v": (3.0, 4.8),
    "batt_ma": (-2000, 500),
}
