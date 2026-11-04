"""aico_status.py, the Python Status row writer, against contracts/status-row.schema.json,
contracts/status-row-fixtures.json and a fake aico-web on loopback (never the live one)."""

from __future__ import annotations

import importlib.util
import json
import logging
import threading
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "aico_status", Path(__file__).resolve().parents[1] / "aico_status.py"
)
assert SPEC and SPEC.loader
aico_status = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(aico_status)

SCHEMA = json.loads((ROOT / "contracts/status-row.schema.json").read_text())
FIXTURES = json.loads((ROOT / "contracts/status-row-fixtures.json").read_text())
ROW = FIXTURES["valid"][0]["row"]


def test_lists_and_limits_match_the_schema():
    props = SCHEMA["properties"]
    assert tuple(SCHEMA["required"]) == aico_status.REQUIRED
    assert frozenset(props) == aico_status.FIELDS
    assert tuple(props["kind"]["enum"]) == aico_status.KINDS
    assert tuple(props["state"]["enum"]) == aico_status.STATES
    action = props["actions"]["items"]["properties"]
    assert tuple(action["kind"]["enum"]) == aico_status.ACTION_KINDS
    assert props["actions"]["maxItems"] == aico_status.MAX_ACTIONS
    assert action["ref"]["maxLength"] == aico_status.MAX_ACTION_REF
    for field, (limit, pattern) in aico_status.TEXT_LIMITS.items():
        assert props[field]["maxLength"] == limit
        assert props[field].get("pattern") == (pattern.pattern if pattern else None)


@pytest.mark.parametrize("item", FIXTURES["valid"], ids=lambda item: item["name"])
def test_accepts_valid_fixtures(item):
    assert aico_status.check_row(item["row"])["id"] == item["row"]["id"]


@pytest.mark.parametrize("item", FIXTURES["invalid"], ids=lambda item: item["name"])
def test_refuses_invalid_fixtures(item):
    with pytest.raises(aico_status.RowError) as caught:
        aico_status.check_row(item["row"])
    assert caught.value.field == item["field"]


def test_times_go_out_in_utc_like_aico_web_writes_them():
    eastern = timezone(timedelta(hours=-5))
    row = aico_status.check_row(
        {
            **ROW,
            "last_run": "2026-11-02T22:30:00-05:00",
            "next_run": datetime(2026, 11, 3, 4, 30, 0, 250000, tzinfo=eastern),
        }
    )
    assert row["last_run"] == "2026-11-03T03:30:00.000Z"
    assert row["next_run"] == "2026-11-03T09:30:00.250Z"
    with pytest.raises(aico_status.RowError, match="timezone"):
        aico_status.check_row({**ROW, "next_run": datetime(2026, 11, 3)})
    with pytest.raises(aico_status.RowError):
        aico_status.check_row({**ROW, "next_run": "2026-02-30T00:00:00Z"})


@contextmanager
def fake_aico(status: int, answer: dict) -> Generator[tuple[str, list[dict]]]:
    seen: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers["Content-Length"])
            seen.append(
                {
                    "path": self.path,
                    "host": self.headers["Host"],
                    "origin": self.headers.get("Origin"),
                    "body": json.loads(self.rfile.read(length)),
                }
            )
            data = json.dumps(answer).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/api/status/rows", seen
    finally:
        server.shutdown()
        server.server_close()


def test_posts_a_row_and_a_list_to_loopback():
    with fake_aico(200, {"written": 1}) as (url, seen):
        assert aico_status.report(ROW, url=url) is True
        assert aico_status.report([ROW, {**ROW, "id": "davion-sidarli/other"}], url=url) is True
    assert seen[0]["path"] == "/api/status/rows"
    assert seen[0]["host"].startswith("127.0.0.1:")
    assert seen[0]["origin"] is None
    assert seen[0]["body"] == ROW
    assert [row["id"] for row in seen[1]["body"]] == [
        "davion-sidarli/aico-web",
        "davion-sidarli/other",
    ]


def test_reads_the_url_from_the_environment(monkeypatch):
    with fake_aico(200, {"written": 1}) as (url, seen):
        monkeypatch.setenv("AICO_STATUS_URL", url)
        assert aico_status.report(ROW) is True
    assert len(seen) == 1


def test_fails_soft_with_a_logged_reason(caplog):
    caplog.set_level(logging.ERROR, logger="aico.status")
    with fake_aico(422, {"detail": "kind: kind must be one of check"}) as (url, seen):
        assert aico_status.report(ROW, url=url) is False
        assert aico_status.report({**ROW, "kind": "cron"}, url=url) is False
    assert len(seen) == 1
    assert "HTTP 422" in caplog.text and "kind must be one of" in caplog.text
    assert "status row not sent: kind" in caplog.text
    with fake_aico(200, {}) as (url, _seen):
        pass
    assert aico_status.report(ROW, url=url, timeout=1) is False
    assert "not answering" in caplog.text


def test_now_is_written_in_utc():
    now = datetime.now(UTC)
    assert aico_status.check_row({**ROW, "last_run": now})["last_run"].endswith("Z")
