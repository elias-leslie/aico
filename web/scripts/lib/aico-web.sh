#!/usr/bin/env bash
# Run a command of the Aico web server bundle (web/server/dist/aico-web.mjs):
# tsession, tclaude, tcodex. The bundle is rebuilt first when it is missing or
# older than its sources, so a fresh checkout works without a deploy.
# Node resolution order: $AICO_NODE, /usr/local/bin/node, /usr/bin/node, PATH.

set -euo pipefail

AICO_WEB_LIB_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
AICO_REPO_ROOT="$(cd "$AICO_WEB_LIB_DIR/../../.." && pwd)"
AICO_WEB_SERVER="$AICO_REPO_ROOT/web/server"
AICO_WEB_BUNDLE="$AICO_WEB_SERVER/dist/aico-web.mjs"

aico_web_node() {
  local candidate
  for candidate in "${AICO_NODE:-}" /usr/local/bin/node /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "aico-web: Node.js >= 22.13 not found; set AICO_NODE" >&2
  return 127
}

aico_web_stale() {
  [ ! -r "$AICO_WEB_BUNDLE" ] && return 0
  [ -n "$(find "$AICO_WEB_SERVER/src" "$AICO_REPO_ROOT/tether/src/client" "$AICO_REPO_ROOT/tether/src/term" \
    -name '*.ts' -newer "$AICO_WEB_BUNDLE" -print -quit 2>/dev/null)" ]
}

aico_web_build() {
  local node="$1"
  mkdir -p "$AICO_WEB_SERVER/dist"
  (
    flock 9
    aico_web_stale || exit 0
    PATH="$(dirname "$node"):$PATH" npm --prefix "$AICO_WEB_SERVER" run --silent build >&2
  ) 9>"$AICO_WEB_SERVER/dist/.build.lock"
}

exec_aico_web() {
  local node
  node="$(aico_web_node)"
  if aico_web_stale; then
    aico_web_build "$node" || {
      echo "aico-web: could not build $AICO_WEB_BUNDLE (run npm ci in $AICO_REPO_ROOT)" >&2
      exit 127
    }
  fi
  # node:sqlite still announces itself as experimental on every run.
  exec "$node" --disable-warning=ExperimentalWarning "$AICO_WEB_BUNDLE" "$@"
}
