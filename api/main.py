"""FastAPI backend: serves readings to the dashboard as JSON.

Run from the repo root:  uvicorn api.main:app --reload --port 8000
"""
import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# Load .env from the repo root BEFORE creating the data source (it reads env vars)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from api.sources import make_source  # noqa: E402  (must come after load_dotenv)

log = logging.getLogger("api")
source = make_source()
app = FastAPI(title="TEG Harvest API")

# CORS: let the browser call this API from the Vite dev server, plus any deployed origins
extra = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", *extra], allow_methods=["GET"])


def from_source(method, *args):
    """Call a data-source method; turn any failure (no internet, missing file) into HTTP 503."""
    try:
        return method(*args)
    except Exception as e:
        log.warning("data source error: %s", e)
        raise HTTPException(status_code=503, detail=f"{source.name} data source unavailable")


def parse_ts(text):
    """Parse an ISO 8601 timestamp into a UTC datetime (a timestamp with no zone is treated as UTC)."""
    # In a URL, "+00:00" arrives as " 00:00" because "+" means space; put the "+" back
    dt = datetime.fromisoformat(text.strip().replace(" ", "+"))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def downsample(rows, max_points):
    """Keep every Nth row so at most max_points remain, always including the first and last row."""
    if len(rows) <= max_points:
        return rows
    step = math.ceil(len(rows) / (max_points - 1))  # leaves room for the last row
    kept = rows[::step]  # starts with the first row
    if kept[-1] is not rows[-1]:
        kept.append(rows[-1])
    return kept


@app.get("/api/health")
def health():
    return {"ok": True, "source": source.name}


@app.get("/api/latest")
def latest():
    return from_source(source.latest)  # None becomes JSON null


@app.get("/api/readings")
def readings(since: str | None = None, max_points: int = Query(2000, ge=2)):
    if since:
        try:
            since = parse_ts(since).isoformat()
        except ValueError:
            raise HTTPException(status_code=400, detail="since must be an ISO 8601 timestamp")
    return downsample(from_source(source.readings, since), max_points)


@app.get("/api/summary")
def summary():
    first, last = from_source(source.first), from_source(source.latest)
    count = from_source(source.count)
    if not first:
        return {"first_ts": None, "latest_ts": None, "count": 0, "energy_wh": 0, "charge_mah": 0, "avg_power_w": 0}

    # Average power = energy stored so far / hours of data (skip the first minute: too noisy)
    hours = (parse_ts(last["ts"]) - parse_ts(first["ts"])).total_seconds() / 3600
    avg_power_w = last["energy_wh"] / hours if hours >= 1 / 60 else 0
    return {
        "first_ts": first["ts"],
        "latest_ts": last["ts"],
        "count": count,
        "energy_wh": last["energy_wh"],
        "charge_mah": last["charge_mah"],
        "avg_power_w": round(avg_power_w, 4),
    }
