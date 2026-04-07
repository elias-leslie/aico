"""Safe filesystem browsing for pane-scoped file exploration."""

from __future__ import annotations

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

FORBIDDEN_DIRS: frozenset[str] = frozenset({".git", ".env"})
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


def resolve_safe_path(root_path: str, relative_path: str) -> Path:
    """Resolve a path inside the pane root without allowing traversal."""
    root = Path(root_path).resolve()
    target = (root / relative_path).resolve()
    target.relative_to(root)
    for part in Path(relative_path).parts:
        if part in FORBIDDEN_DIRS:
            raise PermissionError(f"Access denied: {part}")
    return target


def _entry_info(entry: Path, root: Path) -> dict[str, object]:
    relative = str(entry.relative_to(root))
    data: dict[str, object] = {
        "name": entry.name,
        "path": relative,
        "absolute_path": str(entry),
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

    root = Path(root_path).resolve()
    entries = []
    for entry in sorted(target.iterdir(), key=lambda candidate: (not candidate.is_dir(), candidate.name.lower())):
        if entry.name.startswith(".") and entry.is_dir():
            continue
        if entry.is_dir() and entry.name in SKIP_DIRS:
            continue
        entries.append(_entry_info(entry, root))
    return {
        "entries": entries,
        "path": relative_path or "",
        "root": str(root),
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
        "absolute_path": str(target),
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
