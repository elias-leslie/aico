import type { TuiSpec } from './spec'

const BASE_TUI_ENV = {
  COLORTERM: 'truecolor',
  CLICOLOR: '1',
} as const

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

/** The shell line typed into a freshly-created session to launch the TUI, or
 * null for a bare shell (empty command). Any per-TUI env is exported inline so
 * it applies to the launched process. Universal — never branches on slug. */
export function launchLine(spec: TuiSpec): string | null {
  if (spec.command.length === 0) return null
  const env = { ...BASE_TUI_ENV, ...(spec.env ?? {}) }
  const prefix = [
    'env',
    '-u',
    'NO_COLOR',
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
  ]
  return [...prefix, ...spec.command.map(shellQuote)].join(' ')
}

/**
 * Wrap a launch line into the command tmux runs as the pane's own process. The
 * TUI is the pane from the first paint, so nothing echoes the launch line into
 * scrollback the way typing it into an interactive shell did. Dropping to an
 * interactive shell when the TUI exits keeps a bare-shell widget's behavior:
 * exiting the agent leaves a usable prompt rather than a dead pane.
 */
export function paneCommand(line: string): string {
  // `\${SHELL:-/bin/bash}` is escaped so it reaches the pane shell verbatim for
  // it to expand — it is the shell's parameter expansion, not JS interpolation.
  return `${line}; exec "\${SHELL:-/bin/bash}"`
}
