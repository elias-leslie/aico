#!/usr/bin/env bash

set -euo pipefail

PROJECT_LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERMINAL_SCRIPTS_DIR="$(cd "$PROJECT_LAUNCHER_DIR/.." && pwd)"
WORKSPACES_ROOT="${ST_WORKSPACES_ROOT:-/srv/workspaces}"

project_has_terminal_indicators() {
  local dir="$1"

  [ -d "$dir/.claude" ] || \
  [ -d "$dir/.gemini" ] || [ -d "$dir/.codex" ] || \
  [ -f "$dir/package.json" ] || [ -f "$dir/pyproject.toml" ] || \
  [ -f "$dir/Cargo.toml" ] || [ -f "$dir/go.mod" ] || \
  [ -f "$dir/composer.json" ] || [ -f "$dir/Gemfile" ] || \
  [ -f "$dir/Makefile" ] || [ -f "$dir/CMakeLists.txt" ]
}

project_root_from_st() {
  local project="$1"
  command -v st >/dev/null 2>&1 || return 1

  local root
  root="$(ST_PROGRESS_ONLY=1 st projects root "$project" 2>/dev/null | head -n 1 | tr -d '\r')"
  [ -n "$root" ] || return 1
  printf '%s\n' "$root"
}

discover_registered_projects() {
  command -v st >/dev/null 2>&1 || return 0

  ST_PROGRESS_ONLY=1 st projects list 2>/dev/null | python3 -c '
import json, sys
try:
    projects = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for project in projects:
    project_id = project.get("id") or ""
    root_path = project.get("root_path") or ""
    if project_id and root_path:
        print(f"{project_id}\t{root_path}")
'
}

resolve_terminal_project_dir() {
  local project="$1"
  local candidate

  candidate="$(project_root_from_st "$project" || true)"
  if [ -n "$candidate" ] && [ -d "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$WORKSPACES_ROOT/projects/$project"
  if [ -d "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$HOME/$project"
  if [ -d "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

discover_terminal_projects() {
  declare -A seen=()
  local project root

  while IFS=$'\t' read -r project root; do
    [ -n "$project" ] || continue
    [ -d "$root/.git" ] || continue
    project_has_terminal_indicators "$root" || continue
    seen["$project"]=1
    printf '%s\n' "$project"
  done < <(discover_registered_projects)

  local projects=()
  local base_dir
  local dir
  for base_dir in "$WORKSPACES_ROOT/projects" "$HOME"; do
    [ -d "$base_dir" ] || continue
    for dir in "$base_dir"/*/; do
      [ -d "$dir/.git" ] || continue
      project_has_terminal_indicators "$dir" || continue
      project="$(basename "$dir")"
      [ -n "${seen[$project]:-}" ] && continue
      projects+=("$project")
    done
  done
  printf '%s\n' "${projects[@]}"
}

select_terminal_project() {
  local tool="$1"
  local active_output
  active_output="$("$TERMINAL_SCRIPTS_DIR/tsession" list --tool "$tool" --format project-id 2>/dev/null || true)"

  local -A active_projects=()
  local project
  while IFS= read -r project; do
    [ -n "$project" ] && active_projects["$project"]=1
  done <<< "$active_output"

  local projects=()
  while IFS= read -r project; do
    [ -n "$project" ] && projects+=("$project")
  done < <(discover_terminal_projects)

  if [ ${#projects[@]} -eq 0 ]; then
    echo "No projects found (need .git + project indicator)" >&2
    return 1
  fi

  local display=()
  for project in "${projects[@]}"; do
    if [[ -n "${active_projects[$project]:-}" ]]; then
      display+=("$project [active]")
    else
      display+=("$project")
    fi
  done

  local selected
  selected=$(printf '%s\n' "${display[@]}" | fzf --height=10 --reverse --prompt="Select project: ") || true
  if [ -z "$selected" ]; then
    echo "No project selected" >&2
    return 1
  fi

  printf '%s\n' "${selected% \[active\]}"
}

launch_terminal_project_tool() {
  local tool="$1"
  local selected="${2:-}"

  if [ "$selected" = "-l" ]; then
    "$TERMINAL_SCRIPTS_DIR/tsession" list --tool "$tool"
    return 0
  fi

  if [ -z "$selected" ]; then
    selected="$(select_terminal_project "$tool")" || return 1
  fi

  local project_dir
  project_dir="$(resolve_terminal_project_dir "$selected" || true)"
  if [ ! -d "$project_dir" ]; then
    echo "Project '$selected' not found" >&2
    return 1
  fi

  exec "$TERMINAL_SCRIPTS_DIR/tsession" open \
    --tool "$tool" \
    --project "$selected" \
    --cwd "$project_dir" \
    --attach
}
