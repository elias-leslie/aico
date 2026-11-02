#!/usr/bin/env bash
# Put this checkout's Aico on another machine and (re)start it there. For a host without SummitFlow (such as the gem
# container); a SummitFlow host deploys with `st service rebuild aico`. Deploy the machine with the older database first,
# so a newer schema never reaches a host that cannot read it (docs/INSTALL.md "A second machine").
#
#   scripts/deploy-remote.sh <ssh-host>            copy the git-tracked tree, then run scripts/install.sh --start there
#   scripts/deploy-remote.sh <ssh-host> --dry-run  show what would be copied; change nothing
#
# <ssh-host> is an alias from ~/.ssh/config that logs in without a prompt. The tree lands in AICO_REMOTE_DIR
# (default /srv/workspaces/projects/aico, the path the shipped units expect), with node_modules and builds kept
# between runs. install.sh does everything else, so there is no second installer.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="${AICO_REMOTE_DIR:-/srv/workspaces/projects/aico}"
HOST=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "deploy-remote: unknown argument: $arg (see --help)" >&2
      exit 2
      ;;
    *)
      [ -z "$HOST" ] || {
        echo "deploy-remote: one host at a time" >&2
        exit 2
      }
      HOST="$arg"
      ;;
  esac
done
[ -n "$HOST" ] || {
  echo "usage: scripts/deploy-remote.sh <ssh-host> [--dry-run]" >&2
  exit 2
}
case "$REMOTE_DIR" in
  /* ) ;;
  *) echo "deploy-remote: AICO_REMOTE_DIR must be an absolute path" >&2; exit 2 ;;
esac
case "$REMOTE_DIR" in
  *[[:space:]%\\\"\'*?[]{}]*) echo "deploy-remote: AICO_REMOTE_DIR has characters install.sh cannot render into units" >&2; exit 2 ;;
esac

cd "$REPO"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "deploy-remote: note: uncommitted changes in tracked files are copied as they are" >&2
fi

# Tracked files that still exist (a deleted-but-uncommitted file is skipped, not an rsync error).
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
git ls-files -z | while IFS= read -r -d '' file; do
  [ -e "$file" ] && printf '%s\0' "$file"
done >"$list"

rsync_args=(-a --from0 --files-from="$list" -e "ssh -o BatchMode=yes")
[ "$DRY_RUN" = 1 ] && rsync_args+=(--dry-run --itemize-changes)

echo "==> Copying to $HOST:$REMOTE_DIR"
ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_DIR'"
rsync "${rsync_args[@]}" ./ "$HOST:$REMOTE_DIR/"

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: nothing was changed. Next it would run scripts/install.sh --start on $HOST."
  exit 0
fi

echo "==> Installing on $HOST"
ssh -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && scripts/install.sh --start"
