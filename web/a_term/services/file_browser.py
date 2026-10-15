"""Safe filesystem browsing for pane-scoped file exploration."""

from __future__ import annotations

import os
from fnmatch import fnmatchcase
from pathlib import Path

BINARY_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".pyc", ".pyo", ".so", ".dll", ".exe", ".bin",
        ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
        ".woff", ".woff2", ".ttf", ".eot",
        ".mp3", ".mp4", ".wav", ".ogg", ".webm",
        ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
        ".sqlite", ".db",
    }
)

EXTENSION_TO_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".json": "json",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "css",
    ".md": "markdown",
    ".mdx": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sql": "sql",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "cpp",
    ".h": "cpp",
    ".hpp": "cpp",
    ".xml": "xml",
    ".svg": "xml",
    ".php": "php",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".toml": "toml",
    ".dockerfile": "dockerfile",
}

# Path parts the browser never lists or reads (secrets and keys), matched case-insensitively against every part of
# both the requested path and the resolved target, so a symlink inside the root cannot point at one either. SSH key
# names are spelled out so source files such as id_utils.py stay readable. Hidden directories (.aws, .config, .claude,
# .gnupg, ...) are refused as a whole, the same way listings leave them out, which covers a pane rooted at $HOME.
DENIED_GLOBS: tuple[str, ...] = (
    ".git",
    ".git-credentials",
    ".env*",
    ".ssh",
    ".netrc",
    ".pgpass",
    ".npmrc",
    ".pypirc",
    ".*_history",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    "credentials",
    "credentials.json",
    "*.credentials.json",
    "auth.json",
)
SKIP_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        ".next",
        "dist",
        "build",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "data",
        ".beads",
        "backups",
        "references",
        "logs",
        "test-results",
        ".idea",
        ".vscode",
    }
)

MAX_FILE_SIZE = 1_048_576


def _safe_root(root_path: str) -> Path:
    if "\x00" in root_path:
        raise ValueError("Invalid pane root path")
    return Path(os.path.realpath(os.path.abspath(os.path.expanduser(root_path))))


def is_denied(name: str) -> bool:
    lowered = name.lower()
    return any(fnmatchcase(lowered, pattern) for pattern in DENIED_GLOBS)


def _refuse_denied(parts: tuple[str, ...], *, last_is_dir: bool = True) -> None:
    """Refuse denied names and hidden directories; every part but the last is a directory."""
    for index, part in enumerate(parts):
        is_dir = index < len(parts) - 1 or last_is_dir
        if is_denied(part) or (is_dir and part.startswith(".")):
            raise PermissionError(f"Access denied: {part}")


def _safe_relative(relative_path: str) -> Path:
    if "\x00" in relative_path:
        raise PermissionError("Access denied: invalid path")
    candidate = Path(relative_path or "")
    if candidate.is_absolute():
        raise PermissionError("Access denied: absolute paths are not allowed")
    if ".." in candidate.parts:
        raise PermissionError("Access denied: ..")
    _refuse_denied(candidate.parts, last_is_dir=False)
    return candidate


def resolve_safe_path(root_path: str, relative_path: str) -> Path:
    """Resolve a path inside the pane root without allowing traversal or a denied part (before or after symlinks)."""
    root = _safe_root(root_path)
    target = (root / _safe_relative(relative_path)).resolve()
    if os.path.commonpath([str(root), str(target)]) != str(root):
        raise PermissionError("Access denied: path escapes pane root")
    is_dir = target.is_dir()
    _refuse_denied(target.relative_to(root).parts, last_is_dir=is_dir)
    if is_dir:
        _refuse_denied(Path(relative_path or "").parts[-1:])
    return target


def _entry_info(entry: Path, root: Path) -> dict[str, object]:
    relative = str(entry.relative_to(root))
    data: dict[str, object] = {
        "name": entry.name,
        "path": relative,
        "is_directory": entry.is_dir(),
    }
    if entry.is_dir():
        try:
            children = [
                child for child in entry.iterdir()
                if not (child.name.startswith(".") and child.is_dir())
                and not (child.is_dir() and child.name in SKIP_DIRS)
            ]
            data["children_count"] = len(children)
        except PermissionError:
            data["children_count"] = 0
    else:
        try:
            data["size"] = entry.stat().st_size
        except OSError:
            data["size"] = 0
        data["extension"] = entry.suffix.lower() if entry.suffix else None
    return data


def list_directory(root_path: str, relative_path: str = "") -> dict[str, object]:
    """List one directory level within the pane root."""
    target = resolve_safe_path(root_path, relative_path)
    if not target.is_dir():
        raise FileNotFoundError(f"Not a directory: {relative_path}")

    root = _safe_root(root_path)
    entries = []
    for entry in sorted(target.iterdir(), key=lambda candidate: (not candidate.is_dir(), candidate.name.lower())):
        if entry.name.startswith(".") and entry.is_dir():
            continue
        if entry.is_dir() and entry.name in SKIP_DIRS:
            continue
        if is_denied(entry.name):
            continue
        entries.append(_entry_info(entry, root))
    return {
        "entries": entries,
        "path": relative_path or "",
        "total": len(entries),
    }


def _detect_language(name: str, extension: str) -> str | None:
    language = EXTENSION_TO_LANGUAGE.get(extension)
    if not language and name.lower() in ("dockerfile", "containerfile"):
        return "dockerfile"
    return language


def _is_binary(path: Path, extension: str) -> bool:
    if extension in BINARY_EXTENSIONS:
        return True
    try:
        with open(path, "rb") as handle:
            return b"\x00" in handle.read(8192)
    except OSError:
        return True


def _read_text_content(target: Path, truncated: bool) -> str:
    try:
        with open(target, encoding="utf-8", errors="replace") as handle:
            return handle.read(MAX_FILE_SIZE) if truncated else handle.read()
    except (OSError, UnicodeDecodeError) as err:
        raise ValueError(f"Cannot read file: {err}") from err


def read_file(root_path: str, relative_path: str) -> dict[str, object]:
    """Read one file inside the pane root."""
    target = resolve_safe_path(root_path, relative_path)
    if not target.is_file():
        raise FileNotFoundError(f"Not a file: {relative_path}")

    stat = target.stat()
    extension = target.suffix.lower()
    base: dict[str, object] = {
        "path": relative_path,
        "name": target.name,
        "size": stat.st_size,
        "extension": extension or None,
        "truncated": False,
    }

    if _is_binary(target, extension):
        return {
            **base,
            "content": None,
            "lines": 0,
            "is_binary": True,
            "language": None,
        }

    truncated = stat.st_size > MAX_FILE_SIZE
    content = _read_text_content(target, truncated)
    lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    return {
        **base,
        "content": content,
        "lines": lines,
        "is_binary": False,
        "language": _detect_language(target.name, extension),
        "truncated": truncated,
    }
