// Terminal byte path: one terminal link per open window. A link is either a
// node-pty running Tether's exact `tmux attach` argv or a tmux control-mode
// client (tmux-control.ts); the terminal-transport setting picks which. Killing
// a link only detaches, so the session survives close, reload and Aico restarts.

import type { BrowserWindow, IpcMain } from 'electron'
import type { spawn } from 'node-pty'
import { describeFailure, writeNotice } from './notices'
import { PERSONAL_WORKSPACE_ID } from './project'
import type { SessionCatalog } from './session-catalog'
import {
  type AttachTarget,
  attachEnvironment,
  attachSocketTarget,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  TetherUnavailable,
} from './tether-client'
import { ControlTerminal, type TerminalLink } from './tmux-control'
import { coalesceTrailingAsync, refreshAttachedClients } from './tmux-view'
import type { WindowRegistry } from './window-registry'

const TMUX_QUERY_TIMEOUT_MS = 2_000
const TRANSPORT_SETTING = 'terminal-transport'

type TerminalTransport = 'attach' | 'control'

interface PtySize {
  cols: number
  rows: number
}

// Clamp renderer-supplied terminal geometry to sane integers before it reaches
// tmux (-x/-y) and node-pty: a non-integer, negative, NaN, or absurd value would
// otherwise create a degenerate session or throw deep inside pty.resize.
const MAX_TERM_DIM = 1000
function clampDim(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(MAX_TERM_DIM, Math.max(1, Math.floor(n))) : fallback
}
export function clampSize(size: PtySize): PtySize {
  return { cols: clampDim(size?.cols, 80), rows: clampDim(size?.rows, 24) }
}

interface TerminalDeps {
  tether: Pick<TetherClient, 'createSession' | 'attach' | 'legacyAttach' | 'resizeClaim'>
  catalog: Pick<SessionCatalog, 'get' | 'upsert'>
  registry: Pick<
    WindowRegistry,
    | 'sessionOf'
    | 'legacyOf'
    | 'pending'
    | 'hasSession'
    | 'hasLegacy'
    | 'senderWindow'
    | 'senderSession'
  >
  windowById(id: number): BrowserWindow | null
  allWindows(): BrowserWindow[]
  /** A new session's window now shows it (windows.bind). */
  bind(win: BrowserWindow, descriptor: SessionDescriptor): void
  ensureView(id: string, open?: boolean): unknown
  /** Re-list every session (the link's one shared refresh). */
  refresh(): Promise<void>
  requestRefresh(): void
  /** Tether is replacing this session's pane: input waits. */
  isReplacing(id: string): boolean
  /** Aico's tiler moved this window a moment ago. */
  recentlyArranged(winId: number): boolean
  titles(): void
  tray(): void
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  /** AICO_TERMINAL_TRANSPORT: wins over the setting when set. */
  forcedTransport?: TerminalTransport
  spawnPty: typeof spawn
  controlTerminal(argv: string[], env: NodeJS.ProcessEnv, size: PtySize): TerminalLink
  execFileAsync(
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string }>
  ensurePersonalWorkspaceRoot(): string | null
  isQuitting(): boolean
  env: NodeJS.ProcessEnv
}

export function createTerminal(deps: TerminalDeps) {
  const { tether, catalog, registry } = deps
  // One terminal link per open window, and the attach target it was started from.
  const ptys = new Map<number, TerminalLink>()
  const attachTargets = new Map<number, AttachTarget>()
  const sizeClaims = new WeakMap<TerminalLink, () => Promise<void>>()
  // The transport each window's renderer was told at load, so its terminal and
  // its link agree until the window reloads.
  const transportOf = new Map<number, TerminalTransport>()
  function configuredTransport(): TerminalTransport {
    if (deps.forcedTransport) return deps.forcedTransport
    return deps.getSetting(TRANSPORT_SETTING) === 'attach' ? 'attach' : 'control'
  }
  const ptyStartGenerations = new Map<number, number>()
  const ptyRefreshes = new Map<
    number,
    { pty: TerminalLink | undefined; generation: number | undefined; request: Promise<void> }
  >()
  // Windows whose attach waits for Tether to come back, with their last grid.
  const awaitingTether = new Map<number, PtySize>()

  async function runTmux(
    target: AttachTarget,
    args: string[],
    maxBuffer = 1024 * 1024,
  ): Promise<string> {
    const { stdout } = await deps.execFileAsync(target.argv[0], args, {
      env: attachEnvironment(deps.env, target),
      timeout: TMUX_QUERY_TIMEOUT_MS,
      maxBuffer,
    })
    return stdout
  }

  function createRequest(pending: { tool: string; projectId: string }, size: PtySize) {
    if (pending.projectId === PERSONAL_WORKSPACE_ID) {
      const root = deps.ensurePersonalWorkspaceRoot()
      return { tool: pending.tool, ...(root ? { projectRoot: root } : {}), size }
    }
    return { tool: pending.tool, projectId: pending.projectId, size }
  }

  async function startPty(win: BrowserWindow, size: PtySize): Promise<void> {
    const winId = win.id
    const generation = (ptyStartGenerations.get(winId) ?? 0) + 1
    ptyStartGenerations.set(winId, generation)
    const stillCurrent = () => !win.isDestroyed() && ptyStartGenerations.get(winId) === generation
    const existing = ptys.get(winId)
    if (existing) {
      existing.kill() // detaches the client; the tmux session persists
      ptys.delete(winId)
    }
    awaitingTether.delete(winId)

    const legacyName = registry.legacyOf(winId)
    if (legacyName) {
      await startLegacyPty(win, legacyName, size, stillCurrent)
      return
    }

    let widgetId = registry.sessionOf(winId)
    if (!widgetId) {
      const pending = registry.pending(winId)
      if (!pending) return
      let created: SessionDescriptor
      try {
        created = await tether.createSession(createRequest(pending, size))
      } catch (error) {
        if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
        if (stillCurrent()) writeNotice(win, describeFailure('Could not start the session', error))
        return
      }
      if (win.isDestroyed()) {
        // The window closed during the create: the session keeps running and is
        // reopenable from the tray, exactly like a closed view.
        catalog.upsert(created)
        deps.ensureView(created.id, false)
        deps.tray()
        return
      }
      deps.bind(win, created)
      widgetId = created.id
      if (created.status !== 'running' && created.failure) {
        writeNotice(
          win,
          `Tether could not confirm the launch (${created.failure.reason ?? created.failure.code}).`,
          33,
        )
      }
      deps.tray()
    }
    if (!stillCurrent()) return

    let target: AttachTarget
    try {
      target = await tether.attach(widgetId)
    } catch (error) {
      if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
      if (stillCurrent()) writeNotice(win, describeFailure('Could not attach', error))
      deps.tray()
      return
    }
    if (!stillCurrent() || registry.sessionOf(winId) !== widgetId) return
    const id = widgetId
    let pty: TerminalLink
    try {
      pty = openLink(winId, target, size)
    } catch (error) {
      writeNotice(win, describeFailure('Could not attach', error))
      return
    }
    if (!stillCurrent()) {
      pty.kill()
      return
    }
    const isCurrent = () =>
      !deps.isQuitting() &&
      !win.isDestroyed() &&
      registry.sessionOf(winId) === id &&
      ptys.get(winId) === pty &&
      ptyStartGenerations.get(winId) === generation &&
      !deps.isReplacing(id)
    // Desktop auto-resize: a window claims the shared tmux window size for its
    // own attached client (Tether's active-client resize claim) when it attaches,
    // gains focus, or is resized by Aico's tiling. Callers pick the moment.
    const claimSize = coalesceTrailingAsync(async () => {
      for (let attempt = 0; attempt < 4 && isCurrent(); attempt += 1) {
        const sessionGeneration = catalog.get(id)?.generation ?? target.generation
        try {
          const result = await tether.resizeClaim(
            id,
            sessionGeneration,
            pty.pid,
            pty.cols,
            pty.rows,
          )
          if (result.applied) return
          if (result.reason === 'stale') await deps.refresh().catch(() => {})
          else if (result.reason !== 'client_not_attached' && result.reason !== 'tmux_unavailable')
            return
        } catch (error) {
          if (error instanceof TetherError && error.code === 'stale_generation') {
            await deps.refresh().catch(() => {})
            continue
          }
          if (!(error instanceof TetherUnavailable))
            console.warn(`[aico] resize claim failed widget=${id}:`, error)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    })
    sizeClaims.set(pty, claimSize)
    let claimAfterAttach = true
    pty.onData((data) => {
      if (claimAfterAttach && isCurrent()) {
        claimAfterAttach = false
        void claimSize()
      }
      if (!win.isDestroyed()) win.webContents.send('pty:data', data)
    })
    pty.onExit(() => {
      // Only clear the map if this is still the current pty: a prior pty killed on
      // re-attach can fire its exit after the replacement is stored.
      if (ptys.get(winId) === pty) {
        ptys.delete(winId)
        attachTargets.delete(winId)
        if (!deps.isQuitting()) deps.requestRefresh()
      }
    })
    ptys.set(winId, pty)
    attachTargets.set(winId, target)
    if (win.isFocused()) void claimSize()
  }

  /** The window's terminal link: a control-mode client when its renderer runs
   * the control transport, else a PTY running Tether's `tmux attach` argv. */
  function openLink(winId: number, target: AttachTarget, size: PtySize): TerminalLink {
    const env = attachEnvironment(deps.env, target)
    if (transportOf.get(winId) === 'control') return deps.controlTerminal(target.argv, env, size)
    return deps.spawnPty(target.argv[0], target.argv.slice(1), {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: deps.env.HOME,
      env,
    })
  }

  /** Attach a legacy A-Term session. Tether gives no generation for it, so there
   * is no resize claim; the attach client sizes the window as tmux decides. */
  async function startLegacyPty(
    win: BrowserWindow,
    name: string,
    size: PtySize,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const winId = win.id
    let target: AttachTarget
    try {
      target = await tether.legacyAttach(name)
    } catch (error) {
      if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
      if (stillCurrent()) writeNotice(win, describeFailure('Could not attach', error))
      return
    }
    if (!stillCurrent()) return
    const pty = deps.spawnPty(target.argv[0], target.argv.slice(1), {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: deps.env.HOME,
      env: attachEnvironment(deps.env, target),
    })
    pty.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send('pty:data', data)
    })
    pty.onExit(() => {
      if (ptys.get(winId) === pty) {
        ptys.delete(winId)
        attachTargets.delete(winId)
      }
    })
    ptys.set(winId, pty)
    attachTargets.set(winId, target)
  }

  function resumeAwaitingAttaches(): void {
    for (const [winId, size] of awaitingTether) {
      const win = deps.windowById(winId)
      awaitingTether.delete(winId)
      if (win && !win.isDestroyed()) {
        void startPty(win, size)
          .then(() => deps.titles())
          .catch((error) => console.error('[aico] PTY restart failed:', error))
      }
    }
  }

  function ptyFor(sender: Electron.WebContents): TerminalLink | undefined {
    const win = registry.senderWindow(sender)
    return win ? ptys.get(win.id) : undefined
  }

  function registerIpc(ipcMain: Pick<IpcMain, 'on' | 'handle'>): void {
    ipcMain.on('pty:start', (event, size: PtySize) => {
      const win = registry.senderWindow(event.sender)
      if (win) {
        void startPty(win, clampSize(size))
          .then(() => deps.titles()) // fill the titlebar once the session is attached
          .catch((error) => console.error('[aico] PTY start failed:', error))
      }
    })

    ipcMain.on('pty:input', (event, data: unknown) => {
      if (typeof data !== 'string' || data.length === 0) return
      const widgetId = registry.senderSession(event.sender)
      if (!widgetId || deps.isReplacing(widgetId)) return
      ptyFor(event.sender)?.write(data)
    })

    // Control-mode windows paste through tmux, which brackets the paste only
    // when the program asked for bracketed paste.
    ipcMain.on('pty:paste', (event, text: unknown) => {
      if (typeof text !== 'string' || text.length === 0) return
      const widgetId = registry.senderSession(event.sender)
      if (!widgetId || deps.isReplacing(widgetId)) return
      const link = ptyFor(event.sender)
      if (link instanceof ControlTerminal) link.paste(text)
      else link?.write(text)
    })

    // The renderer asks once, before it starts its terminal; the answer holds
    // for this window until it reloads. Legacy A-Term sessions stay on attach.
    ipcMain.handle('terminal:transport', (event): TerminalTransport => {
      const win = registry.senderWindow(event.sender)
      if (!win) return 'attach'
      const transport = registry.hasLegacy(win.id) ? 'attach' : configuredTransport()
      transportOf.set(win.id, transport)
      return transport
    })
    ipcMain.handle('terminal:transport-setting', () => configuredTransport())
    // Switch every window: each reloads and reattaches on the other transport.
    // Sessions are untouched; only the views reattach.
    ipcMain.on('terminal:toggle-transport', () => {
      deps.setSetting(TRANSPORT_SETTING, configuredTransport() === 'control' ? 'attach' : 'control')
      for (const win of deps.allWindows()) {
        if (!win.isDestroyed() && (registry.hasSession(win.id) || registry.hasLegacy(win.id)))
          win.webContents.reload()
      }
    })

    ipcMain.on('pty:resize', (event, size: PtySize) => {
      const win = registry.senderWindow(event.sender)
      const pty = ptyFor(event.sender)
      if (pty) {
        const { cols, rows } = clampSize(size)
        try {
          pty.resize(cols, rows)
          const arranged = win ? deps.recentlyArranged(win.id) : false
          if (win?.isFocused() || arranged) void sizeClaims.get(pty)?.()
        } catch (err) {
          console.warn('[aico] pty resize failed:', err)
        }
      }
    })

    // Manual Refresh: tmux holds the authoritative grid, so force every client
    // attached to this session to repaint from it — recovering an xterm view that
    // desynced (resize-reflow race, WebGL glitch, dropped/duped bytes).
    // Best-effort: a missing session or no clients is a no-op, never a crash.
    ipcMain.on('pty:refresh', (event, size?: PtySize) => {
      const win = registry.senderWindow(event.sender)
      const widgetId = win ? registry.sessionOf(win.id) : undefined
      if (!win || !widgetId || deps.isQuitting() || deps.isReplacing(widgetId)) return
      // Re-pair a drifted pty before the repaint: if the pty's size disagrees with
      // the renderer's live grid, tmux paints for the wrong geometry.
      const pty = ptyFor(event.sender)
      if (pty && size) {
        const { cols, rows } = clampSize(size)
        if (pty.cols !== cols || pty.rows !== rows) {
          console.warn(
            `[aico] refresh: size desync (pty ${pty.cols}x${pty.rows}, term ${cols}x${rows}); re-pairing`,
          )
          try {
            pty.resize(cols, rows)
          } catch (err) {
            console.warn('[aico] pty resize failed:', err)
          }
        }
      }
      const generation = ptyStartGenerations.get(win.id)
      const pending = ptyRefreshes.get(win.id)
      if (pending && pending.pty === pty && pending.generation === generation) return
      const target = attachTargets.get(win.id)
      const attached = target ? attachSocketTarget(target.argv) : null
      const isCurrent = () =>
        !deps.isQuitting() &&
        !win.isDestroyed() &&
        registry.sessionOf(win.id) === widgetId &&
        ptys.get(win.id) === pty &&
        ptyStartGenerations.get(win.id) === generation &&
        !deps.isReplacing(widgetId)
      const request = (async () => {
        if (pty) await sizeClaims.get(pty)?.()
        if (pty instanceof ControlTerminal) {
          if (isCurrent()) pty.reseed()
          return
        }
        if (target && attached && isCurrent())
          await refreshAttachedClients(attached, (args) => runTmux(target, args), isCurrent)
      })()
      ptyRefreshes.set(win.id, { pty, generation, request })
      void request
        .catch((err) => console.warn('[aico] pty refresh failed:', err))
        .finally(() => {
          if (ptyRefreshes.get(win.id)?.request === request) ptyRefreshes.delete(win.id)
        })
    })
  }

  return {
    /** Tether is back: start every terminal that was waiting for it. */
    resumeAwaiting: resumeAwaitingAttaches,
    /** The window gained focus: claim the session's size for its terminal. */
    claimSize: (winId: number): void => {
      const pty = ptys.get(winId)
      if (pty) void sizeClaims.get(pty)?.()
    },
    /** The window is gone: detach its terminal first (the session persists), then
     * drop its per-window state. An in-flight refresh entry is left, as before. */
    forget: (winId: number): void => {
      const pty = ptys.get(winId)
      if (pty) {
        pty.kill()
        ptys.delete(winId)
      }
      awaitingTether.delete(winId)
      attachTargets.delete(winId)
      transportOf.delete(winId)
      ptyStartGenerations.delete(winId)
    },
    registerIpc,
  }
}
