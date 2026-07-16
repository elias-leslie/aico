import type { TuiSpec } from './spec'

const BASE_TUI_ENV = {
  COLORTERM: 'truecolor',
  CLICOLOR: '1',
} as const

/** PATH inherited by the no-profile/no-RC launch gate. */
export function paneGatePath(base: NodeJS.ProcessEnv = process.env): string {
  return base.PATH ?? ''
}

/** PATH used to resolve a TUI command after its declarative env is applied. */
export function effectiveTuiPath(spec: TuiSpec, base: NodeJS.ProcessEnv = process.env): string {
  return spec.env?.PATH ?? paneGatePath(base)
}

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
    '/usr/bin/env',
    '-u',
    'NO_COLOR',
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
  ]
  return [...prefix, ...spec.command.map(shellQuote)].join(' ')
}

/**
 * Build the command Aico sends only after the pane's containment identity is
 * verified. `null` replaces the no-RC gate with the user's real interactive
 * shell. A TUI is followed by that same shell so exiting the agent leaves a
 * usable prompt rather than a dead pane.
 */
export function paneCommand(line: string | null): string {
  const interactiveShell = `exec "\${SHELL:-/bin/bash}"`
  if (line === null) return interactiveShell

  // `runInPaneArgs` types this line into the already-contained no-RC gate. Clear
  // the typed launcher from both the visible grid and scrollback before the TUI
  // paints, preserving the clean first frame without racing tmux's cgroup move.
  const clearTypedLauncher = "printf '\\033[3J\\033[H\\033[2J'"
  // Replace the no-RC gate itself with a small supervisor shell. Leaving the
  // gate as the pane root while the TUI ran as its child made every healthy
  // workload indistinguishable from a contaminated pre-launch gate during
  // restart reconciliation. The supervisor is deliberately a different exact
  // argv; after the TUI exits it still execs the user's interactive shell.
  const supervisorScript = `${clearTypedLauncher}; ${line}; ${interactiveShell}`
  return `exec /bin/bash --noprofile --norc -c ${shellQuote(supervisorScript)}`
}
