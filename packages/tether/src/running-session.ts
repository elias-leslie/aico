// Operations on a session that is running in its tmux pane: run a tmux
// command, act only on the exact running generation, paste text, press keys.
// Shared by the HTTP routes (lifecycle-api.ts), the reboot checkpoint
// (reboot.ts) and the wake scheduler (wake-runtime.ts), which lifecycle-api.ts
// itself registers; this module keeps those from importing each other.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getWidget, type WidgetRow } from './lifecycle/catalog'
import {
  lifecycleOwners,
  releaseLifecycleOwner,
  rootManagedGateState,
  tmuxPaneTargetForWidget,
} from './lifecycle/engine'
import { sessionGeneration } from './lifecycle/owner-retirement'
import { MUTATION_WAIT_MS, widgetMutationOperation } from './lifecycle/root-control'
import { terminalClientEnv } from './lifecycle/terminal-env'
import {
  bracketedPasteTargetArgs,
  isBoundedTerminalText,
  type PaneKey,
  sendKeyTargetArgs,
} from './lifecycle/tmux'

const execFileAsync = promisify(execFile)
export const TMUX_BIN = '/usr/bin/tmux'
const TMUX_TIMEOUT_MS = 2_000

/** The session's opaque fence (Aico `sessionGeneration`). */
export function generationOf(row: WidgetRow): string {
  return sessionGeneration(row)
}

export async function runTmux(args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, {
    encoding: 'utf8',
    env: terminalClientEnv(),
    timeout: TMUX_TIMEOUT_MS,
    maxBuffer,
  })
  return stdout
}

/**
 * Run `apply` only against the exact running generation while holding the one
 * lifecycle lock (Aico `widgetMutationOperation`). A session of that generation
 * that is briefly busy or still settling is waited for (MUTATION_WAIT_MS).
 * Returns the apply outcome, or `false` when the session is not the exact
 * running workload by then.
 */
export async function withRunningSession<T>(
  widgetId: string,
  generation: string,
  apply: (row: WidgetRow) => Promise<T>,
): Promise<T | false> {
  let outcome: T | undefined
  const ok = await widgetMutationOperation(
    widgetId,
    generation,
    {
      acquire: (id) => lifecycleOwners.acquire(id),
      release: (id, owner) => releaseLifecycleOwner(id, owner),
      getWidget,
      gateState: rootManagedGateState,
      apply: async (row) => {
        outcome = await apply(row)
      },
    },
    { ms: MUTATION_WAIT_MS },
  )
  return ok ? (outcome as T) : false
}

/** Paste `text` into a running session and submit it (the inject route's
 * paste mode). False when the session is not running. */
export async function pasteIntoRunningSession(widgetId: string, text: string): Promise<boolean> {
  const row = getWidget(widgetId)
  if (!row || !isBoundedTerminalText(text)) return false
  const delivered = await withRunningSession(row.id, generationOf(row), async (current) => {
    await runTmux(bracketedPasteTargetArgs(tmuxPaneTargetForWidget(current.id), text, true))
    return true
  })
  return delivered === true
}

/** Press named keys in a running session's pane, in order, only while it is
 * the exact `generation` (or its current one when omitted). False when it is
 * not running, busy, or has no pane. */
export async function pressKeysInRunningSession(
  widgetId: string,
  keys: readonly PaneKey[],
  generation?: string,
): Promise<boolean> {
  const row = getWidget(widgetId)
  if (!row || keys.length === 0) return false
  const pressed = await withRunningSession(
    row.id,
    generation ?? generationOf(row),
    async (current) => {
      const target = tmuxPaneTargetForWidget(current.id)
      for (const key of keys) await runTmux(sendKeyTargetArgs(target, key))
      return true
    },
  )
  return pressed === true
}
