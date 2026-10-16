// Attention wiring: flash a window and badge the tray when a session needs the
// owner (attention.ts), show it on the window's own eyes, and after 2 minutes
// unanswered send one Nightshift push to the phone.

import type { ExecFileException } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import {
  Attention,
  type AttentionMode,
  type AttentionStage,
  agentName,
  pushBody,
  pushEventLine,
  pushOutcome,
} from './attention'
import { type SessionCatalog, sessionTitle, toolDisplayName } from './session-catalog'
import type { SessionDescriptor, TetherTool } from './tether-client'
import type { WindowRegistry } from './window-registry'

interface AttentionWiringDeps {
  registry: Pick<WindowRegistry, 'forSession' | 'sessionOf'>
  catalog: Pick<SessionCatalog, 'get'>
  tools(): TetherTool[]
  /** The tray's "needs you" icon. */
  setNeedsYou(on: boolean): void
  execFile(
    file: string,
    args: string[],
    options: { timeout: number },
    callback: (error: ExecFileException | null, stdout: string | Buffer) => void,
  ): unknown
  /** The per-widget event log (the sidecar's JSONL). */
  logEvent(id: string, event: string, data: Record<string, unknown>): void
  nightshift: string
  atermUrl: string
}

export function createAttentionWiring(deps: AttentionWiringDeps) {
  const { registry, catalog } = deps

  /** What each waiting window shows on itself; resent when a window (re)loads. */
  const attending = new Map<string, { mode: AttentionMode; stage: AttentionStage }>()

  function sendAttention(win: BrowserWindow): void {
    const id = registry.sessionOf(win.id)
    if (!id || win.isDestroyed()) return
    win.webContents.send('eyes:attention', attending.get(id) ?? { mode: 'none', stage: 'fresh' })
  }

  const attention = new Attention({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    isFocused: (id) => registry.forSession(id)?.isFocused() ?? false,
    flash: (id, on) => registry.forSession(id)?.flashFrame(on),
    needsYou: (on) => deps.setNeedsYou(on),
    attend: (id, mode, stage) => {
      if (mode === 'none') attending.delete(id)
      else attending.set(id, { mode, stage })
      const win = registry.forSession(id)
      if (win) sendAttention(win)
    },
    push: (id) => {
      const descriptor = catalog.get(id)
      if (!descriptor) return
      const title = sessionTitle(descriptor)
      const agent = agentName(
        descriptor.stateSource,
        toolDisplayName(descriptor.tool, deps.tools()),
      )
      // Nightshift's own Web Push to the owner's PWA. Nightshift keys repeats by
      // the --open link (one per session) and keeps them quiet for an hour.
      deps.execFile(
        deps.nightshift,
        [
          'push',
          pushBody(agent, title),
          '--title',
          'Aico: waiting for you',
          '--severity',
          'warning',
          '--open',
          `${deps.atermUrl}/?session=${encodeURIComponent(id)}`,
        ],
        { timeout: 30_000 },
        (error, stdout) => {
          const output = String(stdout ?? '')
          const outcome = pushOutcome(error, output)
          console.log(pushEventLine(id, outcome))
          // The widget log records pushes that reached the phone, not Nightshift's dedupes.
          if (outcome.result === 'sent')
            deps.logEvent(id, 'needs_you_push', {
              result: (output.trim().split('\n').pop() ?? '').trim().slice(0, 80),
            })
        },
      )
    },
  })

  return {
    /** The tray's groups (window-chrome). */
    attention,
    /** Blocked windows two minutes unseen: the other windows' eyes look at them. */
    urgent: (): string[] => attention.urgent(),
    /** A session's latest descriptor: its agent state. */
    update: (descriptor: SessionDescriptor): void => {
      attention.update(descriptor.id, descriptor.state ?? 'unknown', descriptor.stateAt ?? null)
    },
    removed: (id: string): void => attention.removed(id),
    focused: (id: string): void => attention.focused(id),
    /** Resend a (re)loaded window what it shows on itself. */
    sendTo: sendAttention,
  }
}
