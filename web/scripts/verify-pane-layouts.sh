#!/usr/bin/env bash
set -euo pipefail

SESSION="${AGENT_BROWSER_SESSION:-terminal-layout-regression}"
BROWSER_BIN="${AGENT_BROWSER_BIN:-$HOME/.local/bin/agent-browser}"
URL="${1:-http://localhost:3002}"

if [[ ! -x "$BROWSER_BIN" ]]; then
  echo "agent-browser not found at $BROWSER_BIN" >&2
  exit 1
fi

ab() {
  AGENT_BROWSER_SESSION="$SESSION" "$BROWSER_BIN" "$@"
}

click_button_with_text() {
  local text="$1"
  ab eval "
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent || '').includes(${text@Q}) ||
      (node.getAttribute('aria-label') || '').includes(${text@Q}) ||
      (node.getAttribute('title') || '').includes(${text@Q})
    );
    if (!button) throw new Error('Missing button: ' + ${text@Q});
    button.click();
    'clicked';
  " >/dev/null
}

button_count() {
  local result
  result="$(ab eval "
    String(document.querySelectorAll('button[title=\"Close terminal\"]').length)
  " | tr -d '"')"
  if ! [[ "$result" =~ ^[0-9]+$ ]]; then
    echo "Failed to parse button count: $result" >&2
    exit 1
  fi
  echo "$result"
}

prompt_count() {
  local result
  result="$(ab eval "
    String(Array.from(document.querySelectorAll('.xterm-rows'))
      .filter((node) => (node.textContent || '').includes('$')).length)
  " | tr -d '"')"
  if ! [[ "$result" =~ ^[0-9]+$ ]]; then
    echo "Failed to parse prompt count: $result" >&2
    exit 1
  fi
  echo "$result"
}

ensure_panes() {
  local target="$1"
  local current
  current="$(button_count)"

  while (( current < target )); do
    click_button_with_text "Open terminal"
    click_button_with_text "New Ad-Hoc Terminal"
    click_button_with_text "Close terminal manager"
    ab wait 200 >/dev/null
    current="$(button_count)"
  done
}

reduce_panes() {
  local target="$1"
  local current
  current="$(button_count)"

  while (( current > target )); do
    ab eval "
      const buttons = Array.from(document.querySelectorAll('button[title=\"Close terminal\"]'));
      const button = buttons[buttons.length - 1];
      if (!button) throw new Error('Missing close terminal button');
      button.click();
      'clicked';
    " >/dev/null
    ab wait 200 >/dev/null
    current="$(button_count)"
  done
}

assert_layout_option() {
  local expected="$1"
  click_button_with_text "Change pane layout"
  ab eval "
    const options = Array.from(document.querySelectorAll('[role=\"option\"]'))
      .map((node) => (node.textContent || '').replace('✓', '').trim());
    if (!options.includes(${expected@Q})) {
      throw new Error('Expected layout option not found: ' + ${expected@Q} + ' in ' + options.join(', '));
    }
    'ok';
  " >/dev/null
  ab press Escape >/dev/null
}

assert_prompt_count() {
  local expected="$1"
  local actual
  actual="$(prompt_count)"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected $expected visible prompts, found $actual" >&2
    exit 1
  fi
}

echo "Opening $URL with agent-browser session '$SESSION'..."
ab open "$URL" >/dev/null
ab set viewport 2200 1200 >/dev/null
ab wait 500 >/dev/null

reduce_panes 4
ensure_panes 4
assert_layout_option "4 Columns"
assert_prompt_count 4

ensure_panes 6
assert_layout_option "2×3 Grid"
assert_prompt_count 6

echo "Pane layout verification passed."
