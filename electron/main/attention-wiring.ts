// Attention wiring: flash a window and badge the tray when a session needs the
// owner (attention.ts), show it on the window's own eyes, and after 2 minutes
// unanswered send one Nightshift notice (contract v1, tray only); it is resolved
// once the session no longer waits (answered, seen or gone).

import type { ExecFileException } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { RunMember, SessionCatalog, SessionDescriptor, TetherTool } from 'tether/client'
import {
  type AgentState,
  Attention,
  type AttentionMode,
  type AttentionStage,
  agentName,
  pushEventLine,
  pushOutcome,
  pushTitle,
} from './attention'
import type { Compositor } from './compositor'
import { sessionTitle, toolDisplayName } from './session-catalog'
import type { WindowRegistry } from './window-registry'

interface AttentionWiringDeps {
  registry: Pick<WindowRegistry, 'forSession' | 'sessionOf'>
  compositor: Pick<Compositor, 'isFocused'>
  catalog: Pick<SessionCatalog, 'get'>
  /** A workflow run Tether lists, by its member id (`run:<id>`). */
  run?(id: string): RunMember | undefined
  tools(): TetherTool[]
  /** The tray's "needs you" icon. */
  setNeedsYou(on: boolean): void
  execFile(
    file: string,
    args: string[],
    options: { timeout: number },
    callback: (error: ExecFileException | null, stdout: string | Buffer) => void,
  ): { stdin?: { end(data: string): void } | null } | undefined
  nightshift: string
  webUrl: string
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
    isFocused: (id) => {
      const win = registry.forSession(id)
      return win ? deps.compositor.isFocused(win) : false
    },
    flash: (id, on) => registry.forSession(id)?.flashFrame(on),
    needsYou: (on) => deps.setNeedsYou(on),
    attend: (id, mode, stage) => {
      if (mode === 'none') attending.delete(id)
      else attending.set(id, { mode, stage })
      const win = registry.forSession(id)
      if (win) sendAttention(win)
      const key = pushed.get(id)
      if (key && mode !== 'blocked') {
        pushed.delete(id)
        deps.execFile(
          deps.nightshift,
          ['resolve', key, '--text', 'The session no longer waits on you.'],
          { timeout: 30_000 },
          (error) => {
            if (error) console.log(`[aico:event] needs_you_resolve result=failed widget=${id}`)
          },
        )
      }
    },
    push: (id) => {
      const notice = noticeFor(id)
      if (!notice) return
      pushed.set(id, notice.key)
      // Nightshift's notice contract v1 on stdin: the desktop tray and panel, never the phone.
      const child = deps.execFile(
        deps.nightshift,
        ['push', '--json'],
        { timeout: 30_000 },
        (error, stdout) => {
          if (error?.code === 2)
            console.error(`[aico] Nightshift refused the notice (a bug): ${error.message}`)
          console.log(pushEventLine(id, pushOutcome(error, String(stdout ?? ''))))
        },
      )
      child?.stdin?.end(JSON.stringify(notice))
    },
  })

  /** Sessions with an open notice, by the key it was sent with. */
  const pushed = new Map<string, string>()

  function noticeFor(id: string): WaitingNotice | undefined {
    const run = deps.run?.(id)
    if (run) {
      // A workflow run asking for an answer, opening its page. Its coordinator has been told too and will ask here.
      return waitingNotice({
        key: `aico-run:${id}`,
        title: `Workflow waiting: ${run.title.slice(0, 80)}`,
        body: run.headline ?? 'The run is waiting for your answer.',
        open: run.url.startsWith(`${deps.webUrl}/`) ? run.url : undefined,
      })
    }
    const descriptor = catalog.get(id)
    if (!descriptor) return undefined
    const tools = deps.tools()
    const agent = agentName(descriptor.stateSource, tools, toolDisplayName(descriptor.tool, tools))
    return waitingNotice({
      key: `aico-waiting:${id}`,
      title: pushTitle(agent, sessionTitle(descriptor)),
      body: 'Open it in Aico to answer.',
      open: `${deps.webUrl}/?session=${encodeURIComponent(id)}`,
    })
  }

  return {
    /** Where a session sits in the tray: needs you, working or idle (window-chrome). */
    group: (id: string) => attention.group(id),
    /** Blocked windows two minutes unseen: the other windows' eyes look at them. */
    urgent: (): string[] => attention.urgent(),
    /** A session's latest descriptor: its agent state. */
    update: (descriptor: SessionDescriptor): void => {
      attention.update(descriptor.id, descriptor.state ?? 'unknown', descriptor.stateAt ?? null)
    },
    /** A workflow run's state (it has no descriptor or window). */
    updateId: (id: string, state: AgentState, at: number | null): void =>
      attention.update(id, state, at),
    removed: (id: string): void => attention.removed(id),
    focused: (id: string): void => attention.focused(id),
    /** Resend a (re)loaded window what it shows on itself. */
    sendTo: sendAttention,
  }
}

export interface WaitingNotice {
  v: 1
  source: 'aico'
  kind: 'todo'
  severity: 'warning'
  title: string
  body: string
  key: string
  open?: string
  actions: ['open']
  primary: 'open'
  push: 'tray'
}

/** A session or run waiting on the owner, as a Nightshift notice (contract v1). */
export function waitingNotice(parts: {
  key: string
  title: string
  body: string
  open?: string
}): WaitingNotice {
  return {
    v: 1,
    source: 'aico',
    kind: 'todo',
    severity: 'warning',
    title: parts.title.slice(0, 200),
    body: parts.body.slice(0, 1000),
    key: parts.key.replace(/[^A-Za-z0-9_.:/@+=,-]/g, '-').slice(0, 200),
    ...(parts.open?.startsWith('https://') ? { open: parts.open } : {}),
    actions: ['open'],
    primary: 'open',
    push: 'tray',
  }
}
