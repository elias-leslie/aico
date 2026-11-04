"""Versioned caches: which old versions of a program or browser a family keeps and which are excess.

Port of the planner in ns/checks/waste.py. A family is a directory whose children are versions; the newest `keep`
stay, and so does every link target and every version a running process uses. Housekeeping deletes the excess only
for families marked prune. The family list is [jobs.housekeeping].versioned in data/checks.toml.
"""

from __future__ import annotations

import contextlib
import glob
import os
import re
from pathlib import Path
from typing import Any

STEM = re.compile(r"(.+?)[-_]v?(\d[\w.+-]*)")


def natural_key(name: str) -> list[Any]:
    """'2.1.299' > '2.1.96'; 'chromium-1234' > 'chromium-1208'. Numbers compare as numbers, text as text."""
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"(\d+)", name) if p]


def group_entries(names: list[str], group: str) -> dict[str, list[str]]:
    """{family key: [entry names]}. stem: 'chromium-1208' -> 'chromium'; names without a version are not grouped."""
    if group == "all":
        return {"": sorted(names)} if names else {}
    out: dict[str, list[str]] = {}
    for name in names:
        match = STEM.fullmatch(name)
        if match:
            out.setdefault(match.group(1), []).append(name)
    return out


def plan_family(
    entries: list[tuple[str, float]], keep: int, order: str, protected: set[str]
) -> tuple[list[str], list[str]]:
    """entries: (name, mtime). Keep the newest `keep` and every protected name. Returns (kept, excess), newest first."""

    def by_version(entry: tuple[str, float]) -> Any:
        return (natural_key(entry[0]), entry[1])

    def by_time(entry: tuple[str, float]) -> Any:
        return (entry[1], natural_key(entry[0]))

    ranked = sorted(entries, key=by_version if order == "version" else by_time, reverse=True)
    kept, excess = [], []
    for index, (name, _) in enumerate(ranked):
        (kept if index < keep or name in protected else excess).append(name)
    return kept, excess


def linked_targets(root: Path) -> set[str]:
    """Names in root that a symlink next to root points at (the current/previous links of release layouts)."""
    out: set[str] = set()
    with contextlib.suppress(OSError):
        real = root.resolve()
        for link in root.parent.iterdir():
            if link.is_symlink() and link.resolve().parent == real:
                out.add(link.resolve().name)
    return out


def in_use_paths(proc: Path = Path("/proc")) -> list[str]:
    """Executable and first argv paths of running processes (what a version directory must not lose)."""
    out: set[str] = set()
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        with contextlib.suppress(OSError):
            out.add(os.readlink(entry / "exe").removesuffix(" (deleted)"))
        with contextlib.suppress(OSError):
            args = (entry / "cmdline").read_bytes().decode(errors="replace").split("\0")[:3]
            out.update(arg for arg in args if arg.startswith("/"))
    return sorted(out)


def used_names(root: Path, paths: list[str]) -> set[str]:
    prefixes = {str(root), str(root.resolve())}
    return {
        p[len(pre) + 1 :].split("/", 1)[0]
        for p in paths
        for pre in prefixes
        if p.startswith(pre + "/")
    }


def tree_size(path: Path) -> int:
    if not path.is_dir() or path.is_symlink():
        try:
            return path.lstat().st_size
        except OSError:
            return 0
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                total += (Path(base) / name).lstat().st_size
    return total


def families(
    specs: list[dict[str, Any]], home: str, keep: int, in_use: list[str]
) -> list[dict[str, Any]]:
    """Every configured family on disk with its kept and excess versions (excess paths absolute)."""
    out = []
    for spec in specs:
        root_text = str(spec["root"])
        pattern = root_text.replace("~", home, 1) if root_text.startswith("~") else root_text
        for root_s in sorted(glob.glob(pattern)):
            root = Path(root_s)
            if not root.is_dir() or root.is_symlink():
                continue
            mtimes: dict[str, float] = {}
            try:
                children = [
                    c
                    for c in root.iterdir()
                    if not c.name.startswith(".")
                    and not c.is_symlink()
                    and (c.is_dir() or c.is_file())
                ]
            except OSError:
                continue
            for child in children:
                with contextlib.suppress(OSError):
                    mtimes[child.name] = child.lstat().st_mtime
            protected = linked_targets(root) | used_names(root, in_use)
            project = root.parent.name
            for key, names in group_entries(sorted(mtimes), str(spec.get("group", "all"))).items():
                plan = [(n, mtimes[n]) for n in names]
                kept, excess = plan_family(
                    plan, max(1, keep), str(spec.get("order", "mtime")), protected
                )
                label = str(spec["name"]).replace("{project}", project) + (
                    f" ({key})" if key else ""
                )
                out.append(
                    {
                        "name": label,
                        "root": str(root),
                        "prune": bool(spec.get("prune")),
                        "kept": kept,
                        "excess": [str(root / n) for n in excess],
                    }
                )
    return out
