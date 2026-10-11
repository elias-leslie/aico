"""Agent tools API: A-Term's view of Tether's tool registry."""

from __future__ import annotations

from fastapi.testclient import TestClient

from .fake_tether import FakeTether


def test_list_tools_in_a_term_shape(test_app: TestClient, fake_tether: FakeTether) -> None:
    tools = test_app.get("/api/a-term/agent-tools").json()
    slugs = [tool["slug"] for tool in tools]
    assert slugs[:2] == ["claude-code", "codex"]
    claude = tools[0]
    assert claude["aliases"] == ["claude"]
    assert claude["argv"] == ["claude", "--dangerously-skip-permissions"]
    assert claude["command"] == "claude --dangerously-skip-permissions"
    assert claude["process_name"] == "claude"
    assert claude["context_hook"] == "claude-session-start"
    assert next(tool for tool in tools if tool["slug"] == "codex")["is_default"] is True


def test_list_enabled_only(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.state.tools["agy"]["enabled"] = False
    slugs = {tool["slug"] for tool in test_app.get("/api/a-term/agent-tools?enabled_only=true").json()}
    assert "agy" not in slugs
    assert ("GET", "/v1/tools") in [(m, p) for m, p, _ in fake_tether.calls]


def test_get_by_alias(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.get("/api/a-term/agent-tools/claude")
    assert response.status_code == 200
    assert response.json()["slug"] == "claude-code"
    assert test_app.get("/api/a-term/agent-tools/missing").status_code == 404


def test_create_tool(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.post(
        "/api/a-term/agent-tools",
        json={"slug": "aider", "name": "Aider", "command": "aider --yes", "process_name": "aider",
              "display_order": 7, "aliases": ["ai"]},
    )
    assert response.status_code == 201, response.text
    assert response.json()["argv"] == ["aider", "--yes"]
    sent = next(body for method, path, body in fake_tether.calls if (method, path) == ("POST", "/v1/tools"))
    assert sent == {"slug": "aider", "name": "Aider", "command": "aider --yes", "processName": "aider",
                    "displayOrder": 7, "aliases": ["ai"]}


def test_create_rejects_bad_alias_and_conflicts(test_app: TestClient, fake_tether: FakeTether) -> None:
    bad = test_app.post("/api/a-term/agent-tools", json={"slug": "x", "name": "X", "aliases": ["Bad Alias"]})
    assert bad.status_code == 400
    conflict = test_app.post("/api/a-term/agent-tools", json={"slug": "claude", "name": "Dup"})
    assert conflict.status_code == 409


def test_update_tool_and_slug_is_immutable(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.patch(
        "/api/a-term/agent-tools/pi",
        json={"slug": "renamed", "command": "pi", "color": None, "enabled": False},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["slug"] == "pi"
    assert body["argv"] == ["pi"]
    assert body["enabled"] is False
    sent = next(b for m, _, b in fake_tether.calls if m == "PATCH")
    assert "slug" not in sent
    assert sent == {"command": "pi", "color": None, "enabled": False}


def test_update_unknown_is_404(test_app: TestClient, fake_tether: FakeTether) -> None:
    assert test_app.patch("/api/a-term/agent-tools/missing", json={"name": "x"}).status_code == 404


def test_delete_tool(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.delete("/api/a-term/agent-tools/agy")
    assert response.status_code == 200
    assert response.json() == {"deleted": True, "id": "tool-agy", "slug": "agy"}
    assert "agy" not in fake_tether.state.tools


def test_delete_default_tool_refused(test_app: TestClient, fake_tether: FakeTether) -> None:
    response = test_app.delete("/api/a-term/agent-tools/codex")
    assert response.status_code == 409
    assert "codex" in fake_tether.state.tools


def test_delete_tool_in_use_refused(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.add_session(tool="pi")
    assert test_app.delete("/api/a-term/agent-tools/pi").status_code == 409


def test_tools_when_tether_down(test_app: TestClient, fake_tether: FakeTether) -> None:
    fake_tether.stop()
    response = test_app.get("/api/a-term/agent-tools")
    assert response.status_code == 503
    assert "Tether" in response.json()["detail"]
