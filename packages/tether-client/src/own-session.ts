// The Aico session a CLI command runs in. A harness may strip AICO_WIDGET_ID
// from the shells it starts (Codex's `shell_environment_policy.inherit =
// "core"` does), but the harness process itself, an ancestor of the shell,
// still holds it: without this an ask filed from a Codex session names no
// session, and its answer has nowhere to go.

import { readFileSync } from 'node:fs'

const WIDGET = /^(?:aico-widget-)?[0-9a-f]{8}$/
const MAX_DEPTH = 32

interface ProcReader {
  environ(pid: number): string
  parent(pid: number): number
}

const procReader: ProcReader = {
  environ: (pid) => readFileSync(`/proc/${pid}/environ`, 'utf8'),
  parent: (pid) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[1],
    )
  },
}

/** `env`, with AICO_WIDGET_ID filled in from the nearest ancestor process that
 * holds one when `env` has none. Unreadable /proc entries end the walk. */
export function withOwnWidget(
  env: NodeJS.ProcessEnv,
  start: number = process.pid,
  proc: ProcReader = procReader,
): NodeJS.ProcessEnv {
  if (WIDGET.test(env.AICO_WIDGET_ID ?? '')) return env
  let pid = start
  try {
    for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth += 1) {
      const pair = proc
        .environ(pid)
        .split('\0')
        .find((entry) => entry.startsWith('AICO_WIDGET_ID='))
      const widget = pair?.slice('AICO_WIDGET_ID='.length)
      if (widget && WIDGET.test(widget)) return { ...env, AICO_WIDGET_ID: widget }
      pid = proc.parent(pid)
    }
  } catch {
    // A process gone or not ours to read: the caller keeps what it has.
  }
  return env
}
