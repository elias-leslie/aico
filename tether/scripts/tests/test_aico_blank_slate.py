import importlib.machinery
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "aico-blank-slate"
loader = importlib.machinery.SourceFileLoader("aico_blank_slate", str(SCRIPT))
blank = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(blank)


@pytest.fixture
def run(monkeypatch, tmp_path):
    """Return the exec'd argv and env for `aico-blank-slate ARGV` without starting anything."""
    for name in ("claude", "codex-real"):
        binary = tmp_path / name
        binary.write_text("#!/bin/sh\n")
        binary.chmod(0o755)
    monkeypatch.setenv("CLAUDE_REAL", str(tmp_path / "claude"))
    monkeypatch.setenv("CODEX_REAL", str(tmp_path / "codex-real"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("AGENT_HUB_CONTEXT_PREINJECTED_TEXT", "context")
    exec_calls = []

    def fake_exec(path, argv, env):
        exec_calls.append((argv, env))
        raise SystemExit(0)

    monkeypatch.setattr(blank.os, "execvpe", fake_exec)

    def invoke(*argv):
        with pytest.raises(SystemExit):
            blank.main(list(argv))
        return exec_calls[-1]
    return invoke


def test_claude_keeps_only_pretooluse_guards_model_effort_and_status_line(run, tmp_path, monkeypatch):
    (tmp_path / "claude-home").mkdir()
    workspace = tmp_path / "blank-slate" / "one"
    workspace.mkdir(parents=True)
    monkeypatch.chdir(workspace)
    state = tmp_path / "claude-home/.claude.json"
    state.write_text(json.dumps({"projects": {"/other": {"hasTrustDialogAccepted": True}}, "keep": 1}))
    guard = [{"matcher": "Bash", "hooks": [{"type": "command", "command": "guard"}]}]
    status_line = {"type": "command", "command": "bash statusline.sh", "padding": 1}
    (tmp_path / "claude-home/settings.json").write_text(json.dumps({
        "statusLine": status_line, "outputStyle": "Concise", "model": "opus", "effortLevel": "high", "hooks": {
        "PreToolUse": guard, "SessionStart": [{"hooks": [{"type": "command", "command": "inject"}]}]}}))
    argv, env = run("claude-code", "--permission-mode", "auto")
    assert argv[1:5] == ["--setting-sources", "project,local", "--settings",
                         json.dumps({"hooks": {"PreToolUse": guard}, "model": "opus", "effortLevel": "high",
                                     "statusLine": status_line})]
    assert argv[5:] == ["--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--permission-mode", "auto"]
    assert env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] == env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"
    assert "AGENT_HUB_CONTEXT_PREINJECTED_TEXT" not in env
    trusted = json.loads(state.read_text())
    assert trusted["projects"][str(workspace)] == {"hasTrustDialogAccepted": True}
    assert str(tmp_path / "blank-slate") not in trusted["projects"]
    assert trusted["keep"] == 1 and trusted["projects"]["/other"]["hasTrustDialogAccepted"] is True


def test_codex_turns_off_every_hook_but_pretooluse_and_keeps_trust(run, tmp_path):
    home = tmp_path / "codex-home"
    home.mkdir()
    hooks = home / "hooks.json"
    hooks.write_text(json.dumps({"hooks": {
        "PreToolUse": [{"hooks": [{"command": "guard"}]}],
        "SessionStart": [{"hooks": [{"command": "a"}, {"command": "b"}]}],
        "UserPromptSubmit": [{"hooks": [{"command": "c"}]}]}}))
    (home / "config.toml").write_text(f'[hooks.state."{hooks}:session_start:0:0"]\ntrusted_hash = "sha256:x"\n'
                                      '[mcp_servers.docs]\nurl = "https://example.test"\n[mcp_servers."a.b"]\ncommand = "x"\n')
    argv, _ = run("codex", "--model", "m", "resume", "abc")
    assert argv[1:4] == ["--model", "m", "resume"]
    assert argv[-1] == "abc"
    state = argv[argv.index("-c", argv.index("memories")) + 1]
    assert f'"{hooks}:session_start:0:0" = {{trusted_hash = "sha256:x", enabled = false}}' in state
    assert f'"{hooks}:session_start:0:1" = {{enabled = false}}' in state
    assert f'"{hooks}:user_prompt_submit:0:0" = {{enabled = false}}' in state
    assert "pre_tool_use" not in state
    for flag in ("project_doc_max_bytes=0", "mcp_servers.docs.enabled=false", 'mcp_servers."a.b".enabled=false',
                 "skills.include_instructions=false"):
        assert flag in argv


def test_codex_without_a_subcommand_puts_flags_first(run):
    argv, _ = run("codex", "--yolo")
    assert argv[1:3] == ["-c", "project_doc_max_bytes=0"]
    assert argv[-1] == "--yolo"


def test_pi_skips_extensions_skills_and_context_files(run):
    argv, _ = run("pi", "--approve")
    assert argv == ["pi", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
                    "--no-mcp", "--approve"]


def test_unsupported_tool_is_refused(capsys):
    with pytest.raises(SystemExit) as exit_info:
        blank.main(["antigravity"])
    assert exit_info.value.code == 64
    assert "Blank Slate supports" in capsys.readouterr().err
