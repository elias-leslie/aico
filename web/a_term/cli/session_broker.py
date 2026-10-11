"""``tsession``: open, list and attach Tether sessions from a terminal.

Attaching follows where the caller already is:

- outside tmux, it runs Tether's attach argv;
- inside the same tmux server as the session, it switches the client;
- inside a different tmux server (the default one, for example), tmux cannot
  switch across servers, so it attaches nested with ``TMUX`` unset after a
  notice. ``--print`` only prints the attach command instead.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import asdict

from ..logging_config import configure_cli_logging
from ..services import project_catalog
from ..services.session_broker import (
    BrokerSessionTarget,
    ensure_project_tool_session,
    list_project_tool_sessions,
)
from ..tether import TetherError, TetherUnavailable

_NESTED_NOTICE = (
    "tsession: you are inside a different tmux server; attaching nested. "
    "Detach the inner client with its prefix key then d.\n"
)


def current_tmux_socket(environ: dict[str, str] | None = None) -> str | None:
    """Socket path of the tmux server this shell runs in (``$TMUX`` is ``socket,pid,session``)."""
    value = (environ if environ is not None else os.environ).get("TMUX", "")
    socket_path = value.split(",", 1)[0].strip()
    return socket_path or None


def attach_plan(target: BrokerSessionTarget, environ: dict[str, str] | None = None) -> tuple[str, list[str], dict[str, str]]:
    """Return (kind, argv, env) for attaching to ``target`` from here.

    ``kind`` is ``attach``, ``switch`` or ``nested``.
    """
    env = dict(environ if environ is not None else os.environ)
    env.update(target.attach_env)
    if not target.attach_argv:
        raise ValueError(f"Tether gave no attach target for {target.session_id}")
    inside = current_tmux_socket(env)
    if inside is None:
        return "attach", list(target.attach_argv), env
    if target.tmux_socket and os.path.realpath(inside) == os.path.realpath(target.tmux_socket):
        tmux_bin = target.attach_argv[0]
        argv = [tmux_bin, "-S", target.tmux_socket, "switch-client", "-t", target.attach_argv[-1]]
        return "switch", argv, env
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    return "nested", list(target.attach_argv), env


def _attach(target: BrokerSessionTarget, *, print_only: bool) -> int:
    kind, argv, env = attach_plan(target)
    if print_only:
        prefix = "env -u TMUX -u TMUX_PANE " if kind == "nested" else ""
        print(prefix + shlex.join(argv))
        return 0
    if kind == "nested":
        sys.stderr.write(_NESTED_NOTICE)
        sys.stderr.flush()
    return subprocess.run(argv, env=env, check=False).returncode


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tsession", description="Open and attach Tether sessions")
    subparsers = parser.add_subparsers(dest="command", required=True)

    open_parser = subparsers.add_parser("open", help="Reuse or create a project tool session")
    open_parser.add_argument("--tool", required=True, help="Tool slug or alias, for example claude or codex")
    open_parser.add_argument("--project", required=True, help="Project id")
    open_parser.add_argument("--cwd", help="Working directory to match or start in")
    open_parser.add_argument("--attach", action="store_true", help="Attach to (or switch to) the session")
    open_parser.add_argument("--print", dest="print_only", action="store_true", help="With --attach, print the attach command instead")

    list_parser = subparsers.add_parser("list", help="List running project tool sessions")
    list_parser.add_argument("--tool", help="Filter to one tool slug")
    list_parser.add_argument("--format", choices=("table", "project-id", "json"), default="table", help="Output format")

    projects_parser = subparsers.add_parser("projects", help="List Tether's projects")
    projects_parser.add_argument("--format", choices=("tsv", "json"), default="tsv", help="Output format")
    return parser


def _run_open(args: argparse.Namespace) -> int:
    target = ensure_project_tool_session(project_id=args.project, tool_slug=args.tool, working_dir=args.cwd)
    if args.attach:
        return _attach(target, print_only=args.print_only)
    print(json.dumps(asdict(target)))
    return 0


def _run_list(args: argparse.Namespace) -> int:
    targets = list_project_tool_sessions(tool_slug=args.tool)
    if args.format == "json":
        print(json.dumps([asdict(target) for target in targets]))
        return 0
    if args.format == "project-id":
        project_ids = list(dict.fromkeys(target.project_id for target in targets))
        if project_ids:
            print("\n".join(project_ids))
        return 0
    if not targets:
        print("No running project sessions.")
        return 0
    for target in targets:
        print(f"{target.project_id}\t{target.mode}\t{target.session_id}\t{target.pane_name or '-'}")
    return 0


def _run_projects(args: argparse.Namespace) -> int:
    """Print Tether's projects. Prints nothing (exit 0) while Tether is down."""
    try:
        projects = project_catalog.list_projects_sync()
    except (TetherError, TetherUnavailable):
        return 0
    if args.format == "json":
        print(json.dumps(projects))
        return 0
    for project in projects:
        root = project.get("root_path") or ""
        if "\t" in project["id"] or "\n" in project["id"] or "\t" in root or "\n" in root:
            continue
        print(f"{project['id']}\t{root}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    configure_cli_logging()
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "open":
            return _run_open(args)
        if args.command == "list":
            return _run_list(args)
        if args.command == "projects":
            return _run_projects(args)
    except TetherUnavailable as error:
        sys.stderr.write(f"tsession: Tether is not reachable ({error}). Is tether@default running?\n")
        return 69
    except TetherError as error:
        sys.stderr.write(f"tsession: Tether refused the request ({error.code}).\n")
        return 1
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
