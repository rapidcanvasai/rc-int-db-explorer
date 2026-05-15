"""Shared fixtures for the FastAPI tests.

The DB layer is replaced with an in-memory fake so destructive-ops behavior
can be exercised without spinning up MySQL.
"""

import os
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Make `app` importable when running `pytest` from the repo root.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture
def fake_db(monkeypatch):
    """Replace get_cursor/get_connection so endpoints exercise pure logic."""
    # Import lazily so .env doesn't get loaded before we set our flags below.
    import app.main as main

    state = {
        "executed": [],
        "committed": 0,
        "rowcount": 1,
        "fetchall": [],
        "description": None,
        "raise_on_execute": None,
    }

    class FakeCursor:
        def __init__(self, dictionary=False):
            self.dictionary = dictionary
            self.rowcount = state["rowcount"]
            self.description = state["description"]
            self.with_rows = state["description"] is not None

        def execute(self, sql, params=None):
            state["executed"].append((sql, params))
            if state["raise_on_execute"]:
                exc = state["raise_on_execute"]
                state["raise_on_execute"] = None
                raise exc

        def fetchall(self):
            return list(state["fetchall"])

        def fetchone(self):
            return state["fetchall"][0] if state["fetchall"] else None

        def close(self):
            pass

    class FakeConn:
        def cursor(self, dictionary=False):
            return FakeCursor(dictionary=dictionary)

        def commit(self):
            state["committed"] += 1

        def close(self):
            pass

    @contextmanager
    def fake_get_cursor(dictionary=True):
        yield FakeCursor(dictionary=dictionary)

    @contextmanager
    def fake_get_connection():
        yield FakeConn()

    monkeypatch.setattr(main, "get_cursor", fake_get_cursor)
    monkeypatch.setattr(main, "get_connection", fake_get_connection)
    # Stop the lifespan handler from trying to build a real pool.
    monkeypatch.setattr(main, "_get_pool", MagicMock(return_value=MagicMock()))
    return state


@pytest.fixture
def client(fake_db, monkeypatch):
    """TestClient with destructive ops flag forced OFF."""
    monkeypatch.setenv("DESTRUCTIVE_OPS_ENABLED", "false")
    import app.main as main
    monkeypatch.setattr(main, "DESTRUCTIVE_OPS_ENABLED", False)
    from fastapi.testclient import TestClient
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def destructive_client(fake_db, monkeypatch):
    """TestClient with destructive ops flag forced ON."""
    monkeypatch.setenv("DESTRUCTIVE_OPS_ENABLED", "true")
    import app.main as main
    monkeypatch.setattr(main, "DESTRUCTIVE_OPS_ENABLED", True)
    from fastapi.testclient import TestClient
    with TestClient(main.app) as c:
        yield c
