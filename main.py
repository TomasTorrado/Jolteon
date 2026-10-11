"""Vercel entrypoint: Vercel looks for a FastAPI `app` in a root-level main.py (not api/main.py),
so this file just re-exports the real app. Locally, keep using: uvicorn api.main:app"""
from api.main import app  # noqa: F401
