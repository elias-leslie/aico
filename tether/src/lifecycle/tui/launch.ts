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

/** What the pane supervisor wrote to `<agentExitDir>/<pane scope unit>`:
 * `started` while the agent runs, `exit N` once it exited with status N, or
 * `signal NAME` when the supervisor itself was told to stop (HUP or TERM).
 * A pane whose marker still says `started` after its scope ended was killed
 * with the agent still running: nothing got to write the exit. */
export type AgentExitMarker =
  | { state: 'started' }
  | { state: 'exit'; status: number }
  | { state: 'signal'; signal: string }

export function parseAgentExitMarker(text: string): AgentExitMarker | null {
  const line = text.trim()
  if (line === 'started') return { state: 'started' }
  const exit = /^exit ([0-9]{1,3})$/.exec(line)
  if (exit) return { state: 'exit', status: Number(exit[1]) }
  const signal = /^signal ([A-Z]{2,8})$/.exec(line)
  if (signal) return { state: 'signal', signal: signal[1] as string }
  return null
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
export function paneCommand(line: string | null, agentExitDir: string | null = null): string {
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
  // With `agentExitDir`, the supervisor also records the agent's fate in a
  // file named after its own pane scope (read from /proc/self/cgroup, all
  // builtins): `started`, then `exit N`. A HUP or TERM (a closed pane, a
  // systemctl stop) is recorded as `signal NAME` once the agent has exited.
  // When every process in the pane is SIGKILLed nothing can write, so the
  // file keeps `started`: that is how crash recovery tells such a kill from
  // an exit, since the scope itself then ends with a clean result.
  const mark = agentExitDir
    ? {
        start: `{ read -r tether_cg </proc/self/cgroup && tether_mark=${shellQuote(agentExitDir)}/\${tether_cg##*/} && printf 'started\\n' >"$tether_mark"; } 2>/dev/null; trap '{ [ -n "$tether_mark" ] && printf "signal HUP\\n" >"$tether_mark"; } 2>/dev/null; exit 129' HUP; trap '{ [ -n "$tether_mark" ] && printf "signal TERM\\n" >"$tether_mark"; } 2>/dev/null; exit 143' TERM; `,
        end: `; { [ -n "$tether_mark" ] && printf 'exit %s\\n' "$${AGENT_EXIT_ENV}" >"$tether_mark"; } 2>/dev/null; trap - HUP TERM`,
      }
    : { start: '', end: '' }
  const supervisorScript = `${clearTypedLauncher}; ${lowerOomScore}; ${mark.start}${line}; export ${AGENT_EXIT_ENV}=$?${mark.end}; ${restoreOomScore}; ${interactiveShell}`
  return `exec /bin/bash --noprofile --norc -c ${shellQuote(supervisorScript)}`
}
