"""``a-term`` command line: one-shot cutover helpers.

``a-term migrate-from-postgres``
    Reads the old Postgres tables (read-only) and writes A-Term's local SQLite
    view state: panes and their layout, and project settings. A dry run
    by default; ``--apply`` writes. Rows already in SQLite are kept, so a
    second run changes nothing. Old tool slugs are renamed with the aliases in
    Tether's tool registry, so Tether must be running. With ``--apply`` it also writes the old agent
    tools as JSON for ``a-term import-tools``.

``a-term import-tools FILE``
    Sends the tools from that JSON to Tether's ``POST /v1/tools/import`` in one
    transaction: missing slugs are created, existing ones are only reported
    with their differing fields unless ``--update-existing``. A dry run
    (Tether's ``dryRun``) unless ``--apply``.

Needs the ``migrate`` extra (psycopg) only for ``migrate-from-postgres``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any, LiteralString

from ..branding import REPO_ROOT
from ..logging_config import configure_cli_logging
from ..storage import local_db


def tool_slug_renames() -> dict[str, str]:
    """Old slug -> canonical slug, from the aliases in Tether's tool registry.

    Exits with a clear message when Tether can't be read: without its aliases
    old slugs (``claude``) would be copied unrenamed.
    """
    from ..tether import TetherError, TetherUnavailable, get_client

    try:
        body = get_client().list_tools()
    except (TetherUnavailable, TetherError) as error:
        raise SystemExit(
            f"a-term: can't read Tether's tool registry ({error}); it maps old tool slugs to current ones. "
            "Start Tether and run this again."
        ) from error
    items = body.get("items") if isinstance(body, dict) else []
    return {
        str(alias): str(tool["slug"])
        for tool in items or []
        if isinstance(tool, dict) and tool.get("slug")
        for alias in tool.get("aliases") or []
    }


def canonical_mode(mode: Any, renames: Mapping[str, str]) -> str:
    value = str(mode or "shell")
    return renames.get(value, value)


def default_tools_out() -> Path:
    return local_db.default_db_path().parent / "tether-tools-import.json"


# ---------------------------------------------------------------------------
# Reading Postgres (read-only)
# ---------------------------------------------------------------------------


def _env_file_value(name: str) -> str | None:
    """``name`` from the env files the old service read, without printing it."""
    for path in (REPO_ROOT / ".env.local", REPO_ROOT / ".env", Path.home() / ".env.local"):
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("export "):
                stripped = stripped[len("export ") :].lstrip()
            if not stripped.startswith(f"{name}="):
                continue
            value = stripped.split("=", 1)[1].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            if value:
                return value
    return None


def resolve_database_url(env_name: str) -> str:
    value = os.environ.get(env_name, "").strip() or _env_file_value(env_name)
    if not value:
        raise SystemExit(f"a-term: {env_name} is not set (environment or env files); nothing to migrate from")
    return value


def read_postgres(database_url: str) -> dict[str, list[dict[str, Any]]]:
    """Read the three source tables in one read-only transaction."""
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise SystemExit(
            "a-term: migrate-from-postgres needs psycopg; install the extra: uv sync --extra migrate"
        ) from error

    queries: dict[str, LiteralString] = {
        "panes": (
            "SELECT id, pane_type, project_id, pane_order, pane_name, active_mode, created_at, "
            "width_percent, height_percent, grid_row, grid_col, is_detached FROM a_term_panes ORDER BY pane_order, created_at"
        ),
        "project_settings": (
            "SELECT project_id, enabled, display_order, active_mode, created_at, updated_at "
            "FROM a_term_project_settings ORDER BY display_order, project_id"
        ),
        "agent_tools": (
            "SELECT slug, name, command, process_name, description, color, display_order, is_default, enabled "
            "FROM agent_tools ORDER BY display_order, slug"
        ),
    }
    result: dict[str, list[dict[str, Any]]] = {}
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=False) as connection:
        connection.read_only = True
        with connection.cursor() as cursor:
            for key, sql in queries.items():
                cursor.execute(sql)
                result[key] = [dict(row) for row in cursor.fetchall()]
        connection.rollback()
    return result


# ---------------------------------------------------------------------------
# Planning (pure; tested without Postgres)
# ---------------------------------------------------------------------------


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value else local_db.now_iso()


# The old Settings form saved the accent green as its "no colour" value, so a
# Postgres row holding it almost always meant unset; import it as no colour so
# the tool keeps its built-in colour.
_OLD_NO_COLOUR = "#00ff9f"


def _imported_color(value: Any) -> Any:
    return None if isinstance(value, str) and value.strip().lower() == _OLD_NO_COLOUR else value


def tool_import_entry(row: dict[str, Any], renames: Mapping[str, str]) -> dict[str, Any]:
    slug = canonical_mode(row["slug"], renames)
    return {
        "slug": slug,
        "name": row.get("name") or row["slug"],
        "command": row.get("command") or "",
        "processName": row.get("process_name"),
        "description": row.get("description"),
        "color": _imported_color(row.get("color")),
        "displayOrder": int(row.get("display_order") or 0),
        "isDefault": bool(row.get("is_default")),
        "enabled": bool(row.get("enabled", True)),
        **({"aliases": [row["slug"]]} if slug != row["slug"] else {}),
    }


def build_plan(source: dict[str, list[dict[str, Any]]], renames: Mapping[str, str]) -> dict[str, Any]:
    """Turn the Postgres rows into SQLite rows plus a report.

    ``renames`` maps old tool slugs to Tether's canonical ones (see
    :func:`tool_slug_renames`). Pre-Tether sessions are not copied: A-Term
    shows only Tether's sessions and the user's own tmux sessions.
    """
    panes = []
    for row in source.get("panes", []):
        panes.append(
            {
                "id": str(row["id"]),
                "pane_type": row["pane_type"],
                "project_id": row.get("project_id"),
                "pane_order": int(row.get("pane_order") or 0),
                "pane_name": row.get("pane_name") or "Terminal",
                "active_mode": canonical_mode(row.get("active_mode"), renames),
                "width_percent": float(row.get("width_percent") or 100.0),
                "height_percent": float(row.get("height_percent") or 100.0),
                "grid_row": int(row.get("grid_row") or 0),
                "grid_col": int(row.get("grid_col") or 0),
                "is_detached": 1 if row.get("is_detached") else 0,
                "created_at": _iso(row.get("created_at")),
            }
        )
    settings = [
        {
            "project_id": str(row["project_id"]),
            "enabled": 1 if row.get("enabled") else 0,
            "display_order": int(row.get("display_order") or 0),
            "active_mode": canonical_mode(row.get("active_mode"), renames),
            "created_at": _iso(row.get("created_at")),
            "updated_at": _iso(row.get("updated_at")),
        }
        for row in source.get("project_settings", [])
    ]
    tools = [tool_import_entry(row, renames) for row in source.get("agent_tools", [])]
    return {"panes": panes, "project_settings": settings, "tools": tools}


def apply_plan(plan: dict[str, Any], db_path: Path | None = None) -> dict[str, int]:
    """Insert the plan's rows, keeping any row SQLite already has (idempotent)."""
    counts = {"panes": 0, "project_settings": 0}
    with local_db.transaction(db_path) as db:
        for pane in plan["panes"]:
            cursor = db.execute(
                """INSERT INTO panes (id, pane_type, project_id, pane_order, pane_name, active_mode, width_percent,
                       height_percent, grid_row, grid_col, is_detached, created_at)
                   VALUES (:id, :pane_type, :project_id, :pane_order, :pane_name, :active_mode, :width_percent,
                       :height_percent, :grid_row, :grid_col, :is_detached, :created_at)
                   ON CONFLICT (id) DO NOTHING""",
                pane,
            )
            counts["panes"] += cursor.rowcount
        for setting in plan["project_settings"]:
            cursor = db.execute(
                """INSERT INTO project_settings (project_id, enabled, display_order, active_mode, created_at, updated_at)
                   VALUES (:project_id, :enabled, :display_order, :active_mode, :created_at, :updated_at)
                   ON CONFLICT (project_id) DO NOTHING""",
                setting,
            )
            counts["project_settings"] += cursor.rowcount
    return counts


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def run_migrate(args: argparse.Namespace) -> int:
    source = read_postgres(resolve_database_url(args.database_url_env))
    plan = build_plan(source, tool_slug_renames())
    db_path = Path(args.db).expanduser() if args.db else local_db.default_db_path()
    tools_out = Path(args.tools_out).expanduser() if args.tools_out else default_tools_out()
    report: dict[str, Any] = {
        "mode": "apply" if args.apply else "dry-run",
        "sqlite": str(db_path),
        "tools_json": str(tools_out),
        "source_counts": {key: len(rows) for key, rows in source.items()},
        "panes": len(plan["panes"]),
        "project_settings": len(plan["project_settings"]),
        "tools": [tool["slug"] for tool in plan["tools"]],
    }
    if args.apply:
        report["inserted"] = apply_plan(plan, db_path)
        _write_json(tools_out, {"tools": plan["tools"]})
    print(json.dumps(report, indent=2))
    if not args.apply:
        print("Dry run: nothing written. Re-run with --apply to write SQLite and the tools JSON.", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# Tool import into Tether
# ---------------------------------------------------------------------------


def tether_tool_input(entry: dict[str, Any]) -> dict[str, Any]:
    """One import entry as Tether's ``ToolInput``: unset (``None``) fields are left out.

    A ``None`` would otherwise read as "clear this field" and show up as a
    difference against every tool Tether already has.
    """
    return {key: value for key, value in entry.items() if value is not None}


def run_import_tools(args: argparse.Namespace) -> int:
    from ..tether import TetherError, get_client

    payload = json.loads(Path(args.file).expanduser().read_text())
    entries = payload.get("tools") if isinstance(payload, dict) else payload
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise SystemExit("a-term: tools JSON must be a list or {\"tools\": [...]}")
    try:
        result = get_client().import_tools(
            [tether_tool_input(entry) for entry in entries],
            dry_run=not args.apply,
            update_existing=args.update_existing,
        )
    except TetherError as error:
        print(json.dumps({"mode": "apply" if args.apply else "dry-run", "error": error.code, "detail": error.body}, indent=2))
        return 1
    print(json.dumps({"mode": "apply" if args.apply else "dry-run", **result}, indent=2))
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="a-term", description="A-Term cutover helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    migrate = subparsers.add_parser("migrate-from-postgres", help="Copy view state from the old Postgres tables")
    migrate.add_argument("--apply", action="store_true", help="Write SQLite and the tools JSON (default: dry run)")
    migrate.add_argument("--db", help="SQLite file (default: A-Term's state file)")
    migrate.add_argument("--tools-out", help="Where to write the tools JSON (default: next to the SQLite file)")
    migrate.add_argument(
        "--database-url-env", default="DATABASE_URL", help="Environment variable holding the Postgres URL"
    )

    tools = subparsers.add_parser("import-tools", help="Add migrated agent tools to Tether's registry")
    tools.add_argument("file", help="Tools JSON written by migrate-from-postgres")
    tools.add_argument("--apply", action="store_true", help="Change Tether (default: dry run, nothing written)")
    tools.add_argument("--update-existing", action="store_true", help="Also overwrite differing fields of existing tools")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_cli_logging()
    args = _build_parser().parse_args(argv)
    if args.command == "migrate-from-postgres":
        return run_migrate(args)
    if args.command == "import-tools":
        return run_import_tools(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
