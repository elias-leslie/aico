#!/usr/bin/env bash

set -euo pipefail

PROJECT_LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A_TERM_SCRIPTS_DIR="$(cd "$PROJECT_LAUNCHER_DIR/.." && pwd)"
A_TERM_REPO_ROOT="$(cd "$PROJECT_LAUNCHER_DIR/../.." && pwd)"

DEFAULT_WORKSPACES_ROOT=""
if [ "$(basename "$(dirname "$A_TERM_REPO_ROOT")")" = "projects" ]; then
  DEFAULT_WORKSPACES_ROOT="$(cd "$A_TERM_REPO_ROOT/../.." && pwd)"
fi

WORKSPACES_ROOT="${ST_WORKSPACES_ROOT:-$DEFAULT_WORKSPACES_ROOT}"
# Tests point this at a stub; normally it is the tsession next to this library.
A_TERM_TSESSION="${A_TERM_TSESSION:-$A_TERM_SCRIPTS_DIR/tsession}"

project_has_a_term_indicators() {
  local dir="$1"

  [ -d "$dir/.claude" ] || \
  [ -d "$dir/.gemini" ] || [ -d "$dir/.codex" ] || \
  [ -f "$dir/package.json" ] || [ -f "$dir/pyproject.toml" ] || \
  [ -f "$dir/Cargo.toml" ] || [ -f "$dir/go.mod" ] || \
  [ -f "$dir/composer.json" ] || [ -f "$dir/Gemfile" ] || \
  [ -f "$dir/Makefile" ] || [ -f "$dir/CMakeLists.txt" ]
}

# Tether's project list (SummitFlow when installed, else Tether's local list),
# as "id<TAB>root" lines. Prints nothing when Tether is unreachable.
discover_registered_projects() {
  "$A_TERM_TSESSION" projects --format tsv 2>/dev/null || true
}

project_root_from_tether() {
  local project="$1"
  local id root
  while IFS=$'\t' read -r id root; do
    if [ "$id" = "$project" ] && [ -n "$root" ]; then
      printf '%s\n' "$root"
      return 0
    fi
  done < <(discover_registered_projects)
  return 1
}

resolve_a_term_project_dir() {
  local project="$1"
  local candidate

  candidate="$(project_root_from_tether "$project" || true)"
  if [ -n "$candidate" ] && [ -d "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  if [ -n "$WORKSPACES_ROOT" ]; then
    candidate="$WORKSPACES_ROOT/projects/$project"
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  candidate="$HOME/$project"
  if [ -d "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

discover_a_term_projects() {
  declare -A seen=()
  local project root

  while IFS=$'\t' read -r project root; do
    [ -n "$project" ] || continue
    [ -d "$root/.git" ] || continue
    project_has_a_term_indicators "$root" || continue
    seen["$project"]=1
    printf '%s\n' "$project"
  done < <(discover_registered_projects)

  local projects=()
  local base_dir
  local dir
  for base_dir in ${WORKSPACES_ROOT:+"$WORKSPACES_ROOT/projects"} "$HOME"; do
    [ -d "$base_dir" ] || continue
    for dir in "$base_dir"/*/; do
      [ -d "$dir/.git" ] || continue
      project_has_a_term_indicators "$dir" || continue
      project="$(basename "$dir")"
      [ -n "${seen[$project]:-}" ] && continue
      projects+=("$project")
    done
  done
  printf '%s\n' "${projects[@]}"
}

select_a_term_project() {
  local tool="$1"
  local active_output
  active_output="$("$A_TERM_TSESSION" list --tool "$tool" --format project-id 2>/dev/null || true)"

  local -A active_projects=()
  local project
  while IFS= read -r project; do
    [ -n "$project" ] && active_projects["$project"]=1
  done <<< "$active_output"

  local projects=()
  while IFS= read -r project; do
    [ -n "$project" ] && projects+=("$project")
  done < <(discover_a_term_projects)

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

launch_a_term_project_tool() {
  local tool="$1"
  local selected="${2:-}"

  if [ "$selected" = "-l" ]; then
    "$A_TERM_TSESSION" list --tool "$tool"
    return 0
  fi

  if [ -z "$selected" ]; then
    selected="$(select_a_term_project "$tool")" || return 1
  fi

  local project_dir
  project_dir="$(resolve_a_term_project_dir "$selected" || true)"
  if [ ! -d "$project_dir" ]; then
    echo "Project '$selected' not found" >&2
    return 1
  fi

  # Inside tmux, tsession decides how to reach the target: switch-client only
  # works within one tmux server, and Tether gives each session its own.
  exec "$A_TERM_TSESSION" open \
    --tool "$tool" \
    --project "$selected" \
    --cwd "$project_dir" \
    --attach
}
