// Terminal byte path: one terminal link per open window, a tmux control-mode
// client (tether/term). Killing a link only detaches, so the session
// survives close, reload and Aico restarts.

import type { BrowserWindow, IpcMain } from 'electron'
import {
  type SessionCatalog,
  type SessionDescriptor,
  type TetherClient,
  TetherUnavailable,
  type ViewerLabel,
} from 'tether/client'
import {
  type AttachTarget,
  attachEnvironment,
  createSizeClaim,
  ownAttachTarget,
  type TerminalLink,
} from 'tether/term'
import { describeFailure, writeNotice } from './notices'
import { PERSONAL_WORKSPACE_ID } from './project'
import { ACTIVE_WITHIN_MS, createSizeHolder, type SizeHolder } from './size-holder'
import type { WindowRegistry } from './window-registry'

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
  tether: Pick<TetherClient, 'createSession' | 'attach' | 'resizeClaim'>
  catalog: Pick<SessionCatalog, 'get' | 'upsert'>
  registry: Pick<
    WindowRegistry,
    | 'sessionOf'
    | 'pending'
    | 'hasSession'
    | 'senderWindow'
    | 'senderSession'
    | 'byId'
    | 'all'
    | 'forSession'
  >
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
  controlTerminal(argv: string[], env: NodeJS.ProcessEnv, size: PtySize): TerminalLink
  ensurePersonalWorkspaceRoot(): string | null
  isQuitting(): boolean
  /** Names this app and device on its size claims ("Viewing on …" elsewhere). */
  viewer: ViewerLabel
}

export function createTerminal(deps: TerminalDeps) {
  const { tether, catalog, registry } = deps
  // One terminal link per open window.
  const ptys = new Map<number, TerminalLink>()
  const sizeClaims = new WeakMap<TerminalLink, () => Promise<void>>()
  const sizeHolders = new WeakMap<TerminalLink, SizeHolder>()
  const lastInput = new Map<number, number>()
  const ptyStartGenerations = new Map<number, number>()
  const ptyRefreshes = new Map<
    number,
    { pty: TerminalLink | undefined; generation: number | undefined; request: Promise<void> }
  >()
  // Windows whose attach waits for Tether to come back, with their last grid.
  const awaitingTether = new Map<number, PtySize>()
  // Windows still bound to a session whose terminal link is gone (the pane or
  // tmux died, or attach was refused), with the session generation it was lost
  // on and the last grid. When Tether brings that session back running with a
  // different generation (crash recovery, reboot restore), the same window
  // reattaches. One attempt per generation, so a failing attach cannot loop.
  const linkLost = new Map<number, { generation: string | undefined; size: PtySize }>()

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
      sizeHolders.get(existing)?.dispose()
      existing.kill() // detaches the client; the tmux session persists
      ptys.delete(winId)
    }
    awaitingTether.delete(winId)
    linkLost.delete(winId)

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
      target = ownAttachTarget(await tether.attach(widgetId))
    } catch (error) {
      if (error instanceof TetherUnavailable) awaitingTether.set(winId, size)
      else if (stillCurrent())
        linkLost.set(winId, { generation: catalog.get(widgetId)?.generation, size })
      if (stillCurrent()) writeNotice(win, describeFailure('Could not attach', error))
      deps.tray()
      return
    }
    if (!stillCurrent() || registry.sessionOf(winId) !== widgetId) return
    const id = widgetId
    let pty: TerminalLink
    try {
      pty = deps.controlTerminal(target.argv, attachEnvironment(target), size)
    } catch (error) {
      linkLost.set(winId, { generation: target.generation, size })
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
    // Whether another client holds the size shows in the window as a notice with
    // a Use here button (size-holder.ts); this window's own claims clear it.
    const holder = createSizeHolder({
      reclaim: () => void claimSize(),
      show: (visible) => {
        if (!win.isDestroyed()) win.webContents.send('pty:size-other', visible)
      },
      isActive: () =>
        win.isFocused() && Date.now() - (lastInput.get(winId) ?? -Infinity) < ACTIVE_WITHIN_MS,
    })
    sizeHolders.set(pty, holder)
    if (!win.isDestroyed()) win.webContents.send('pty:size-other', false) // a fresh attach holds nothing against it
    const claimSize = createSizeClaim({
      tether,
      id,
      generation: () => catalog.get(id)?.generation ?? target.generation,
      link: pty,
      viewer: deps.viewer,
      isCurrent,
      refresh: () => deps.refresh(),
      applied: (changed) => {
        holder.held()
        // The window changed size under this client (another client held
        // it): read the pane again, as after any resize.
        if (changed && isCurrent()) pty.settleSize()
      },
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
      sizeHolders.get(pty)?.dispose()
      if (ptys.get(winId) === pty) {
        ptys.delete(winId)
        if (!deps.isQuitting()) {
          if (!win.isDestroyed())
            linkLost.set(winId, {
              generation: target.generation,
              size: { cols: pty.cols, rows: pty.rows },
            })
          deps.requestRefresh()
        }
      }
    })
    ptys.set(winId, pty)
    if (win.isFocused()) void claimSize()
  }

  function resumeAwaitingAttaches(): void {
    for (const [winId, size] of awaitingTether) {
      const win = registry.byId(winId)
      awaitingTether.delete(winId)
      if (win && !win.isDestroyed()) {
        void startPty(win, size)
          .then(() => deps.titles())
          .catch((error) => console.error('[aico] PTY restart failed:', error))
      }
    }
  }

  /** Tether reported this session: if its window lost its terminal link and the
   * session is running again under a new generation, reattach that window. */
  function sessionSeen(descriptor: SessionDescriptor): void {
    if (descriptor.status !== 'running' || deps.isQuitting()) return
    const win = registry.forSession(descriptor.id)
    if (!win || win.isDestroyed()) return
    const lost = linkLost.get(win.id)
    if (!lost || lost.generation === descriptor.generation) return
    if (ptys.has(win.id)) return
    linkLost.delete(win.id)
    console.log(`[aico] reattaching widget=${descriptor.id}: session is running again`)
    void startPty(win, lost.size)
      .then(() => deps.titles())
      .catch((error) => console.error('[aico] PTY reattach failed:', error))
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
      const pty = ptyFor(event.sender)
      const win = registry.senderWindow(event.sender)
      if (win) lastInput.set(win.id, Date.now())
      pty?.write(data)
      if (pty) sizeHolders.get(pty)?.activity()
    })

    // Paste goes through tmux, which brackets it only when the program asked
    // for bracketed paste.
    ipcMain.on('pty:paste', (event, text: unknown) => {
      if (typeof text !== 'string' || text.length === 0) return
      const widgetId = registry.senderSession(event.sender)
      if (!widgetId || deps.isReplacing(widgetId)) return
      ptyFor(event.sender)?.paste(text)
    })

    // The owner clicked in the terminal (a deliberate Use here press, or a
    // plain click): take the size back if another client holds it.
    ipcMain.on('pty:claim-size', (event, deliberate: unknown) => {
      const pty = ptyFor(event.sender)
      const holder = pty ? sizeHolders.get(pty) : undefined
      if (!holder) return
      if (deliberate === true) holder.force()
      else holder.activity()
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

    // Manual Refresh: tmux holds the authoritative grid, so reseed this window
    // from it — recovering an xterm view that desynced (resize-reflow race,
    // WebGL glitch, dropped/duped bytes). Best-effort: a missing session is a
    // no-op, never a crash.
    ipcMain.on('pty:refresh', (event, size?: PtySize) => {
      const win = registry.senderWindow(event.sender)
      const widgetId = win ? registry.sessionOf(win.id) : undefined
      if (!win || !widgetId || deps.isQuitting() || deps.isReplacing(widgetId)) return
      // Re-pair a drifted link before the repaint: if the pty's size disagrees with
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
      const isCurrent = () =>
        !deps.isQuitting() &&
        !win.isDestroyed() &&
        registry.sessionOf(win.id) === widgetId &&
        ptys.get(win.id) === pty &&
        ptyStartGenerations.get(win.id) === generation &&
        !deps.isReplacing(widgetId)
      const request = (async () => {
        if (pty) await sizeClaims.get(pty)?.()
        if (pty && isCurrent()) pty.reseed()
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
    /** Tether reported this session (event or complete list). */
    sessionSeen,
    /** A client claimed this session's size (Tether's `session.resized`): if it is
     * not this window's own terminal, another client now holds the size. */
    sizeHeldBy: (id: string, clientPid: number): void => {
      const win = registry.forSession(id)
      const pty = win ? ptys.get(win.id) : undefined
      const holder = pty ? sizeHolders.get(pty) : undefined
      if (!pty || !holder) return
      if (pty.pid === clientPid) holder.held()
      else holder.lost()
    },
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
        sizeHolders.get(pty)?.dispose()
        pty.kill()
        ptys.delete(winId)
      }
      lastInput.delete(winId)
      awaitingTether.delete(winId)
      linkLost.delete(winId)
      ptyStartGenerations.delete(winId)
    },
    registerIpc,
  }
}
