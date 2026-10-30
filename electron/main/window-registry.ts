// Which Electron window shows which Tether session, or which session still
// being created, and the one place features look windows up. Nearly every
// feature reads this map; it holds no Electron value of its own, only the
// lookups it is given (BrowserWindow's statics).

import type { BrowserWindow, WebContents } from 'electron'

interface WindowLookup {
  fromId(id: number): BrowserWindow | null
  fromWebContents(webContents: WebContents): BrowserWindow | null
  getAllWindows(): BrowserWindow[]
  getFocusedWindow(): BrowserWindow | null
}

/** A window opened for a new session: Tether creates it at the window's first grid size. */
export interface PendingCreate {
  tool: string
  projectId: string
  /** An Agent Hub prompt revision added to the tool's instructions. */
  instructions?: { prompt: string; revision: string }
  /** The remote host to start it on; absent for this computer. */
  host?: string
}

/** A window that reads one workflow step's latest attempt, with no session of its own. */
export interface StepViewer {
  runId: string
  stepKey: string
  /** The window's name: the step and its run. */
  title: string
}

export class WindowRegistry {
  // BrowserWindow.id -> Tether session id. A window opened for a new session has
  // no id until Tether creates it at the window's first grid size.
  private readonly widgetOf = new Map<number, string>()
  private readonly pendingCreates = new Map<number, PendingCreate>()
  private readonly viewerOf = new Map<number, StepViewer>()

  constructor(private readonly bw: WindowLookup) {}

  bindSession = (winId: number, sessionId: string): void => {
    this.widgetOf.set(winId, sessionId)
  }

  setPending = (winId: number, pending: PendingCreate): void => {
    this.pendingCreates.set(winId, pending)
  }

  pending = (winId: number): PendingCreate | undefined => this.pendingCreates.get(winId)

  clearPending = (winId: number): void => {
    this.pendingCreates.delete(winId)
  }

  bindViewer = (winId: number, viewer: StepViewer): void => {
    this.viewerOf.set(winId, viewer)
  }

  /** What a step-reading window shows, by its BrowserWindow id. */
  viewerFor = (winId: number): StepViewer | undefined => this.viewerOf.get(winId)

  /** What the sender's window reads, if it is a step-reading window (untrusted IPC sender). */
  senderViewer = (sender: WebContents): StepViewer | undefined => {
    const win = this.bw.fromWebContents(sender)
    return win ? this.viewerOf.get(win.id) : undefined
  }

  /** The window already reading this step, if any. */
  forStep = (runId: string, stepKey: string): BrowserWindow | undefined => {
    for (const [winId, viewer] of this.viewerOf) {
      if (viewer.runId !== runId || viewer.stepKey !== stepKey) continue
      const win = this.bw.fromId(winId)
      if (win && !win.isDestroyed()) return win
    }
    return undefined
  }

  sessionOf = (winId: number): string | undefined => this.widgetOf.get(winId)

  hasSession = (winId: number): boolean => this.widgetOf.has(winId)

  /** The first live window bound to this session, in binding order. */
  forSession = (id: string): BrowserWindow | undefined => {
    for (const [winId, wid] of this.widgetOf) {
      if (wid === id) {
        const win = this.bw.fromId(winId)
        if (win && !win.isDestroyed()) return win
      }
    }
    return undefined
  }

  /** Every live window bound to a Tether session. */
  sessionWindows = (): BrowserWindow[] =>
    this.bw.getAllWindows().filter((w) => !w.isDestroyed() && this.widgetOf.has(w.id))

  /** The window a renderer belongs to (an IPC sender or a permission request), if any. */
  senderWindow = (sender: WebContents): BrowserWindow | null => this.bw.fromWebContents(sender)

  /** Any window by its BrowserWindow id, bound to a session or not. */
  byId = (winId: number): BrowserWindow | null => this.bw.fromId(winId)

  /** Every window, bound to a session or not. */
  all = (): BrowserWindow[] => this.bw.getAllWindows()

  /** The window with keyboard focus, if it is one of Aico's. */
  focused = (): BrowserWindow | null => this.bw.getFocusedWindow()

  /** The session a renderer's window shows, if any (untrusted IPC sender). */
  senderSession = (sender: WebContents): string | undefined => {
    const win = this.bw.fromWebContents(sender)
    return win ? this.widgetOf.get(win.id) : undefined
  }

  forget = (winId: number): void => {
    this.widgetOf.delete(winId)
    this.pendingCreates.delete(winId)
    this.viewerOf.delete(winId)
  }
}
