"""Fuzz test: feed 10,000 lines (10% corrupted) into the bridge's process_line and check every verdict."""
import json
import random
import time

from common import SEQ_BASE, fake_lines, process_line


def corrupt(line):
    """Break a good line in one of four ways: broken JSON, missing key, wrong type, or empty."""
    raw = json.loads(line)
    kind = random.choice(["broken_json", "missing_key", "wrong_type", "empty"])
    if kind == "broken_json":
        return line[: random.randint(1, len(line) - 2)]  # cut off mid-line
    if kind == "missing_key":
        del raw[random.choice(list(raw))]
    elif kind == "wrong_type":
        key = random.choice(["th", "tc", "gv", "gi", "bv", "bi", "mah", "wh"])
        # null is allowed for th/tc (a missing temperature probe), so it only counts as corruption elsewhere
        raw[key] = random.choice(["hot", True, float("nan")] + ([] if key in ("th", "tc") else [None]))
    else:
        return ""
    return json.dumps(raw)


def run(total=10_000, bad_fraction=0.10):
    random.seed(1)  # same corruption every run, so results are comparable
    lines = fake_lines(total, SEQ_BASE)
    bad_positions = set(random.sample(range(total), int(total * bad_fraction)))
    inputs = [(corrupt(line), False) if i in bad_positions else (line, True) for i, line in enumerate(lines)]

    accepted = rejected = crashes = wrong_verdicts = 0
    start = time.perf_counter()
    for line, should_pass in inputs:
        try:
            ok = process_line(line) is not None
        except Exception:
            crashes += 1
            continue
        accepted += ok
        rejected += not ok
        wrong_verdicts += ok != should_pass  # a good line rejected, or a bad line accepted
    seconds = time.perf_counter() - start

    return {
        "lines_processed": total,
        "corrupted_lines": len(bad_positions),
        "good_accepted": accepted,
        "bad_rejected": rejected,
        "wrong_verdicts": wrong_verdicts,
        "crashes": crashes,
        "lines_per_second": round(total / seconds),
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
