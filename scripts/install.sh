#!/usr/bin/env bash
# Install Aico from this checkout: the web app and the Tether session daemon. For a first install or a host without SummitFlow; on a
# SummitFlow host `st service rebuild aico` deploys instead.
#
#   scripts/install.sh                 build and install; start nothing
#   scripts/install.sh --prebuilt      install artifacts built from this accepted source elsewhere
#   scripts/install.sh --start         ...then enable and (re)start tether@default and the web app
#   scripts/install.sh --dry-run       print what would happen; change nothing
#   scripts/install.sh --skip-systemd  build and install files only (no units, no
#                                      linger/systemd checks; for clean-room runs)
#
# Installs (rerunning changes only what differs):
#   node_modules and the Tether/web builds
#   ~/.local/lib/tether (Tether's bundle, CLI and shims), ~/.local/bin/tether
#   user units from scripts/systemd/ plus packages/tether/deploy/tether@.service
#   (and removes a leftover tether-link@.service: the daemon owns fleet links)
#   ~/.pi/agent/extensions/model-guard.ts (Aico launch rules)
#
# TETHER_LIB_DIR and TETHER_BIN_DIR move the Tether install; XDG_CONFIG_HOME
# moves the units.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

DRY_RUN=0
START=0
SKIP_SYSTEMD=0
PREBUILT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --start) START=1 ;;
    --prebuilt) PREBUILT=1 ;;
    --skip-systemd) SKIP_SYSTEMD=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install: unknown argument: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done
if [ "$START" = 1 ] && [ "$SKIP_SYSTEMD" = 1 ]; then
  echo "install: --start needs systemd; drop --skip-systemd" >&2
  exit 2
fi

LIB_DIR="${TETHER_LIB_DIR:-$HOME/.local/lib/tether}"
BIN_DIR="${TETHER_BIN_DIR:-$HOME/.local/bin}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Started by --start.
START_UNITS=(tether@default.service aico-web.service aico-jobs.service aico-state-snapshot.timer)

fail() {
  echo "install: $*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$1"
}

# Run a command, or print it under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# The checkout path is substituted into systemd units. systemd treats whitespace,
# quotes, backslashes and `%` specially, so refuse paths that cannot be rendered
# literally rather than install a broken unit.
case "$REPO" in
  *[[:space:]%\\\"\']* | *[*?{}]* | *'['* | *']'*)
    fail "the checkout path '$REPO' contains whitespace, quotes, a backslash, '%' or a glob character (*?[]{}); move it to a plain path"
    ;;
esac

# Escape the sed replacement metacharacters (backslash, &, and the # delimiter)
# so the checkout path is substituted literally.
sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'
}

# Write content to target when it differs; returns 1 when it was already current.
install_content() { # content target mode
  local content="$1" target="$2" mode="$3" tmp
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then
    return 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $target"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp "$target.XXXXXX")"
  printf '%s\n' "$content" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$target"
  echo "installed $target"
}

render() { # template -> its text with __PROJECT_ROOT__ set to this checkout
  sed "s#__PROJECT_ROOT__#$(sed_replacement "$REPO")#g" "$1"
}

# Point link at source unless it already does; refuse to replace a real file.
install_link() { # source link
  local source="$1" link="$2"
  [ "$(readlink "$link" 2>/dev/null || true)" = "$source" ] && return 0
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    fail "$link exists and is not a symlink; move it aside"
  fi
  run mkdir -p "$(dirname "$link")"
  run ln -sfn "$source" "$link"
  [ "$DRY_RUN" = 1 ] || echo "linked $link"
}

check_prerequisites() {
  local missing=() command major
  for command in node npm python3 git; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  [ ${#missing[@]} -eq 0 ] || fail "missing: ${missing[*]} (Node.js 22+ with npm, Python 3, git)"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || fail "Node.js 22+ required (found $(node --version))"
  [ "$SKIP_SYSTEMD" = 1 ] && return 0

  # Tether needs a user manager that outlives logout, cgroup v2 and tmux.
  local linger version
  command -v systemctl >/dev/null 2>&1 || fail "a systemd user manager (systemctl) is required"
  version="$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')"
  [ -n "$version" ] && [ "$version" -ge 254 ] || fail "systemd >= 254 required (found ${version:-none})"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || fail "cgroup v2 (unified hierarchy) required"
  [ -x /usr/bin/tmux ] || fail "/usr/bin/tmux not found; install tmux"
  linger="$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || true)"
  if [ "$linger" != yes ]; then
    echo "Enabling user linger so sessions survive logout..."
    run loginctl enable-linger "$USER" || true
    if [ "$DRY_RUN" = 0 ]; then
      linger="$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || true)"
      [ "$linger" = yes ] || fail "user linger is off; run: sudo loginctl enable-linger $USER"
    fi
  fi
  echo "Prerequisites: node $(node --version), systemd $version, cgroup v2, $(/usr/bin/tmux -V)"
}

install_units() {
  local unit changed=0
  for unit in scripts/systemd/*.service scripts/systemd/*.timer; do
    install_content "$(render "$unit")" "$UNIT_DIR/$(basename "$unit")" 0644 && changed=1
  done
  # The generic template, for test instances such as tether@dev.
  install_content "$(cat packages/tether/deploy/tether@.service)" "$UNIT_DIR/tether@.service" 0644 && changed=1
  # Retired: the daemon owns every fleet link. An old copy ran `tether link`,
  # which now exits 2, so an enabled instance crash-looped.
  if [ -e "$UNIT_DIR/tether-link@.service" ]; then
    run rm -f "$UNIT_DIR/tether-link@.service"
    changed=1
  fi
  if [ "$changed" = 1 ]; then
    run systemctl --user daemon-reload ||
      echo "systemd: could not reach the user manager; run 'systemctl --user daemon-reload' later." >&2
  else
    echo "systemd: units are up to date."
  fi
}

check_prerequisites

if [ "$PREBUILT" = 1 ]; then
  step "Using prebuilt Aico artifacts"
  if [ "$DRY_RUN" = 0 ]; then
    for artifact in packages/cli/dist/aico-cli.mjs packages/ops/dist/aico-ops.mjs \
      packages/jobs/dist/aico-jobs.mjs \
      packages/tether/dist/tether.mjs packages/web-server/dist/aico-web.mjs \
      packages/web-frontend/out/index.html; do
      [ -r "$artifact" ] || fail "prebuilt artifact is missing: $artifact"
    done
    [ -d node_modules ] || fail "prebuilt artifact is missing: node_modules"
  fi
else
  step "Node dependencies and builds"
  run npm ci --no-audit --no-fund
  run npm run build
fi

step "Aico command"
install_link "$REPO/packages/cli/scripts/aico" "$BIN_DIR/aico"
install_link "$REPO/packages/cli/scripts/aico" "$BIN_DIR/st"
if [ -n "${AICO_INSTALL_SOURCE_SHA:-}" ]; then
  [[ "$AICO_INSTALL_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail "AICO_INSTALL_SOURCE_SHA must name the exported commit"
  [ "$(basename "$REPO")" = "$AICO_INSTALL_SOURCE_SHA" ] || fail "a committed standalone install belongs in its commit-named release folder"
  [ "$DRY_RUN" = 1 ] || [ -r "$REPO/packages/ops/dist/aico-ops.mjs" ] || fail "the committed ops bundle is missing"
  install_link "$REPO" "$HOME/.local/lib/aico/ops"
fi

step "Tether"
[ "$DRY_RUN" = 1 ] || [ -f packages/tether/dist/tether.mjs ] || fail "packages/tether/dist/tether.mjs is missing after the build"
run env TETHER_LIB_DIR="$LIB_DIR" packages/tether/scripts/install-release.sh
install_link "$LIB_DIR/bin/tether" "$BIN_DIR/tether"

step "Pi model rules"
install_link "$REPO/packages/tether/integrations/pi/model-guard.ts" "$HOME/.pi/agent/extensions/model-guard.ts"

if [ "$SKIP_SYSTEMD" = 0 ]; then
  step "User units"
  install_units
fi

if [ "$START" = 1 ]; then
  step "Starting"
  run systemctl --user enable "${START_UNITS[@]}"
  run systemctl --user restart "${START_UNITS[@]}"
  if [ "$DRY_RUN" = 0 ]; then
    for unit in "${START_UNITS[@]}"; do
      systemctl --user is-active --quiet "$unit" || fail "$unit failed to start; see journalctl --user -u $unit"
    done
    echo "Started: ${START_UNITS[*]}"
  fi
fi

[ "$DRY_RUN" = 1 ] && echo && echo "Dry run: nothing was changed." && exit 0
cat <<EOF

Aico is installed.
  Start Tether and the web app: scripts/install.sh --start
    (or systemctl --user enable --now ${START_UNITS[*]})
  Web app:                      http://localhost:3002
EOF
