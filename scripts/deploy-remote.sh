#!/usr/bin/env bash
# Put a committed, already built Aico release on a standalone full peer (CT 190) and start it there.
# The peer has no checkout and too little memory to build: this copies the workstation's accepted
# release for that commit (source plus its node_modules and built bundles) into a new commit-named
# release folder on the peer, checks the copy, and runs that release's own installer with --prebuilt.
# Configuration and data on the peer are kept. docs/deployment.md has the order and the checks after.
#
#   scripts/deploy-remote.sh <ssh-host>                 the commit the workstation runs now
#   scripts/deploy-remote.sh <ssh-host> --sha COMMIT    a full 40-character commit
#   scripts/deploy-remote.sh <ssh-host> --dry-run       show what would be copied; change nothing
#
# <ssh-host> is an alias from ~/.ssh/config that logs in as the peer's Aico user without a prompt.
# The release must already be built on the workstation (`st service rebuild aico`). A release whose
# deploy built no Tether (Tether did not change) keeps the peer's installed Tether; the workstation's
# signed Tether reaches it with `tether fleet push-update` (scripts/peer-release.sh does both).
# Remote command strings expand on the peer, so they stay single-quoted here.
# shellcheck disable=SC2016
set -euo pipefail

RELEASES="${AICO_RELEASES_DIR:-$HOME/.local/lib/aico/releases}"
# What the peer's installer runs; each one lands in this release by a deploy at its commit.
NEEDED=(web-server web-frontend jobs ops cli)
# Build caches and host-local environments: never part of what a peer runs.
FILTERS=(--exclude=/.aico-release.json --exclude=.next/ --exclude=.venv/ --exclude=__pycache__/
  --exclude=.dev-tools/)
HOST=""
SHA=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --sha)
      [ $# -ge 2 ] || { echo "deploy-remote: --sha needs a commit" >&2; exit 2; }
      SHA="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "deploy-remote: unknown argument: $1 (see --help)" >&2
      exit 2
      ;;
    *)
      [ -z "$HOST" ] || { echo "deploy-remote: one host at a time" >&2; exit 2; }
      HOST="$1"
      ;;
  esac
  shift
done
[ -n "$HOST" ] || { echo "usage: scripts/deploy-remote.sh <ssh-host> [--sha COMMIT] [--dry-run]" >&2; exit 2; }
fail() { echo "deploy-remote: $*" >&2; exit 1; }

if [ -z "$SHA" ]; then
  live="$(readlink -f "$HOME/.local/lib/aico/ops" 2>/dev/null || true)"
  SHA="$(basename "${live:-none}")"
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "no full commit to send ($SHA); pass --sha COMMIT"
release="$RELEASES/$SHA"
[ -r "$release/.aico-release.json" ] || fail "no workstation release for $SHA; deploy it first: st service rebuild aico"
for pkg in "${NEEDED[@]}"; do
  grep -q "\"$pkg\"" "$release/.aico-release.json" || fail "the $SHA release has no $pkg build; run: st service rebuild aico"
done
install_flags=(--prebuilt --start)
if ! grep -q '"tether"' "$release/.aico-release.json"; then
  grep -q -- '--keep-tether)' "$release/scripts/install.sh" ||
    fail "the $SHA release built no Tether and its installer predates --keep-tether; send a later release"
  install_flags+=(--keep-tether)
  echo "==> Release $SHA built no Tether; $HOST keeps its installed Tether"
fi

ssh_peer() { ssh -o BatchMode=yes "$HOST" "$@"; }
remote_home="$(ssh_peer 'printf %s "$HOME"')"
remote_releases="$remote_home/.local/lib/aico/releases"
target="$remote_releases/$SHA"
rsync_base=(-a --delete "${FILTERS[@]}" -e "ssh -o BatchMode=yes")

if ssh_peer "test -d '$target'"; then
  echo "==> $HOST already holds release $SHA"
else
  staging="$remote_releases/.$SHA.partial"
  # Unchanged files are hard links to the peer's current release; a new folder, never an overlay.
  previous="$(ssh_peer 'readlink -f "$HOME/.local/lib/aico/ops" 2>/dev/null || true')"
  link=()
  [ -n "$previous" ] && link=(--link-dest="$previous")
  echo "==> Copying release $SHA to $HOST"
  ssh_peer "mkdir -p '$remote_releases'"
  if [ "$DRY_RUN" = 1 ]; then
    rsync "${rsync_base[@]}" "${link[@]}" --dry-run --stats "$release/" "$HOST:$staging/" | tail -n 15
    echo "Dry run: nothing was changed. Next it would check the copy, then run scripts/install.sh --prebuilt --start there."
    exit 0
  fi
  rsync "${rsync_base[@]}" "${link[@]}" "$release/" "$HOST:$staging/"
  # Compare every file's contents, not only size and time.
  differences="$(rsync "${rsync_base[@]}" --checksum --dry-run --itemize-changes "$release/" "$HOST:$staging/")"
  [ -z "$differences" ] || fail "the copy on $HOST differs from the workstation release:
$(printf '%s\n' "$differences" | head -n 20)"
  ssh_peer "mv '$staging' '$target'"
  echo "==> Copy checked: $HOST matches the workstation release"
fi
if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: nothing was changed. Next it would run scripts/install.sh --prebuilt --start there."
  exit 0
fi

echo "==> Installing $SHA on $HOST"
ssh_peer "cd '$target' && AICO_INSTALL_SOURCE_SHA='$SHA' bash scripts/install.sh ${install_flags[*]}"
ssh_peer 'for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3002/health && exit 0; sleep 1; done; exit 1' ||
  fail "Aico on $HOST did not answer its health check within 30 s"
running="$(ssh_peer 'basename "$(readlink -f "$HOME/.local/lib/aico/ops")"')"
[ "$running" = "$SHA" ] || fail "$HOST runs $running, not $SHA"
# Keep the peer's disk from filling: the running release plus the newest few (ops.json deploy.keepReleases,
# as the workstation keeps); unfinished .partial copies go too. Releases its units or processes use stay.
keep="$(sed -n 's/.*"keepReleases": *\([0-9]*\).*/\1/p' "$release/packages/ops/data/ops.json" | head -n 1)"
pruned="$(ssh_peer "KEEP='${keep:-3}' RUNNING='$SHA' bash -s" <<'PRUNE'
set -euo pipefail
cd "$HOME/.local/lib/aico/releases"
newest="$(ls -1dt -- [0-9a-f]*/ 2>/dev/null | tr -d / | grep -xE '[0-9a-f]{40}' | head -n "$KEEP" || true)"
used="$(cat "$HOME"/.config/systemd/user/*.service 2>/dev/null || true; ls -l /proc/[0-9]*/cwd /proc/[0-9]*/exe 2>/dev/null || true)"
n=0
for d in $(ls -1A); do
  [ "$d" = "$RUNNING" ] && continue
  printf '%s\n' "$newest" | grep -qx -- "$d" && continue
  printf '%s\n' "$used" | grep -qF -- "releases/$d/" && continue
  rm -rf -- "$d"
  n=$((n + 1))
done
echo "$n"
PRUNE
)" || pruned="?"
echo "$HOST runs Aico $SHA and answers its health check (old releases removed: $pruned)."
