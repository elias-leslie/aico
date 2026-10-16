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

/** Agents run at OOM score adjust 100 while the pane's other processes keep
 * the inherited 200 (Nightshift's memctl re-raises their children), so under
 * a pane cap the kernel kills a large tool before the agent unless the agent
 * is itself far larger. The pane supervisor sets it on itself before starting
 * the agent and restores it for the fallback shell; a failed write is
 * ignored, so the agent still starts at the inherited value. */
export const AGENT_OOM_SCORE_ADJ = 100

/** Set in the pane's fallback shell to the agent's exit status. */
export const AGENT_EXIT_ENV = 'TETHER_AGENT_EXIT'

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

/** Native ID semantics belong to the selected TUI adapter, never the caller. */
export function isResumeSessionId(spec: TuiSpec | undefined, value: unknown): value is string {
  return typeof value === 'string' && Boolean(spec?.resume?.sessionIdPattern.test(value))
}

/** Fixed adapter argv prefix; the launch gate supplies one quoted session ID. */
export function resumeLaunchLine(spec: TuiSpec): string | null {
  if (!spec.resume) return null
  return launchLine({ ...spec, command: [...spec.command, ...spec.resume.arguments] })
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
  // The agent's exit status is exported into the fallback shell's
  // environment, where Tether's crash recovery reads it from /proc: 128+N
  // means a signal (an OOM kill is 137), 0 a clean /exit.
  const lowerOomScore = `{ read -r tether_adj </proc/self/oom_score_adj && echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`
  const restoreOomScore = `{ [ -n "$tether_adj" ] && echo "$tether_adj" >/proc/self/oom_score_adj; } 2>/dev/null`
  const supervisorScript = `${clearTypedLauncher}; ${lowerOomScore}; ${line}; export ${AGENT_EXIT_ENV}=$?; ${restoreOomScore}; ${interactiveShell}`
  return `exec /bin/bash --noprofile --norc -c ${shellQuote(supervisorScript)}`
}
