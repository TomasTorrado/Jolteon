"""Restart test: kill the bridge 20 times mid-stream (SIGKILL, like pulling the plug), resend overlapping
seq values after each restart, then check Supabase for duplicates and missing readings."""
import json
import random
import subprocess
import sys
import time
from pathlib import Path

import common
from common import SEQ_BASE, cleanup_supabase, fake_lines, make_client, supabase_seqs

CHILD = Path(__file__).parent / "bridge_child.py"
START = SEQ_BASE + 2_000_000


def start_child():
    return subprocess.Popen([sys.executable, str(CHILD)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)


def run(restarts=20, lines_per_round=30):
    random.seed(2)
    client = make_client()
    cleanup_supabase(client)
    common.reset_test_db()
    lines = fake_lines(restarts * lines_per_round + lines_per_round, START)  # more than we can use
    next_index = resent = 0
    try:
        for _ in range(restarts):
            # Resume a few readings BEFORE where the last bridge got to, so some seqs are sent twice
            overlap = random.randint(0, 10)
            resent += min(overlap, next_index)
            first = max(0, next_index - overlap)
            child = start_child()
            child.stdin.write("\n".join(lines[first:first + lines_per_round]) + "\n")
            child.stdin.flush()
            time.sleep(random.uniform(0.5, 2.5))  # let it save/upload some, then kill mid-stream
            child.kill()
            out, _ = child.communicate()
            saved = [int(word) for word in out.split() if word.isdigit()]
            next_index = (max(saved) - START + 1) if saved else first  # resume after the last saved seq

        # Final, clean run: send the rest of this window and let the bridge finish normally
        child = start_child()
        child.communicate("\n".join(lines[max(0, next_index - 5):next_index + lines_per_round]) + "\n", timeout=120)
        last_index = next_index + lines_per_round - 1

        expected = set(range(START, START + last_index + 1))
        seqs = supabase_seqs(client, START, START + len(lines))
    finally:
        cleanup_supabase(client)
        common.remove_test_db()

    return {
        "restarts": restarts,
        "readings_expected": len(expected),
        "readings_resent_after_restart": resent,
        "in_supabase": len(set(seqs)),
        "duplicates": len(seqs) - len(set(seqs)),
        "missing": len(expected - set(seqs)),
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
