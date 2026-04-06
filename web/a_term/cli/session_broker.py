"""CLI for the shared local A-Term session broker."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import asdict

from ..services.session_broker import ensure_project_tool_session, list_project_tool_sessions


def _attach_to_tmux_session(tmux_session_name: str) -> int:
    command = (
        ["tmux", "switch-client", "-t", tmux_session_name]
        if os.environ.get("TMUX")
        else ["tmux", "attach", "-t", tmux_session_name]
    )
    return subprocess.run(command, check=False).returncode


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tsession", description="A-Term session broker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    open_parser = subparsers.add_parser("open", help="Reuse or create a A-Term-managed tool session")
    open_parser.add_argument("--tool", required=True, help="Agent tool slug, for example claude or codex")
    open_parser.add_argument("--project", required=True, help="Project id, usually the repo directory name")
    open_parser.add_argument("--cwd", help="Working directory for new panes")
    open_parser.add_argument("--attach", action="store_true", help="Attach or switch to the tmux session")

    list_parser = subparsers.add_parser("list", help="List A-Term-managed project sessions")
    list_parser.add_argument("--tool", help="Filter to one tool slug")
    list_parser.add_argument(
        "--format",
        choices=("table", "project-id", "json"),
        default="table",
        help="Output format",
    )
    return parser


def _run_open(args: argparse.Namespace) -> int:
    target = ensure_project_tool_session(
        project_id=args.project,
        tool_slug=args.tool,
        working_dir=args.cwd,
    )
    if args.attach:
        return _attach_to_tmux_session(target.tmux_session_name)

    print(json.dumps(asdict(target)))
    return 0


def _run_list(args: argparse.Namespace) -> int:
    targets = list_project_tool_sessions(tool_slug=args.tool)
    if args.format == "json":
        print(json.dumps([asdict(target) for target in targets]))
        return 0

    if args.format == "project-id":
        project_ids = []
        seen: set[str] = set()
        for target in targets:
            if target.project_id in seen:
                continue
            seen.add(target.project_id)
            project_ids.append(target.project_id)
        if project_ids:
            print("\n".join(project_ids))
        return 0

    if not targets:
        print("No A-Term-managed sessions found.")
        return 0

    for target in targets:
        print(f"{target.project_id}\t{target.mode}\t{target.tmux_session_name}\t{target.pane_name}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "open":
        return _run_open(args)
    if args.command == "list":
        return _run_list(args)
    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
