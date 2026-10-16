// Which Electron window shows which Tether session, which pre-Tether A-Term
// session, or which session still being created. Nearly every feature reads
// this map; it holds no Electron value of its own, only the lookups it is given.

import type { BrowserWindow, WebContents } from 'electron'

interface WindowLookup {
  fromId(id: number): BrowserWindow | null
  fromWebContents(webContents: WebContents): BrowserWindow | null
  getAllWindows(): BrowserWindow[]
}

/** A window opened for a new session: Tether creates it at the window's first grid size. */
export interface PendingCreate {
  tool: string
  projectId: string
}

export class WindowRegistry {
  // BrowserWindow.id -> Tether session id. A window opened for a new session has
  // no id until Tether creates it at the window's first grid size.
  private readonly widgetOf = new Map<number, string>()
  private readonly pendingCreates = new Map<number, PendingCreate>()
  // Windows showing a pre-Tether A-Term session (`summitflow-<uuid>` on the
  // default tmux server): attach-only, no generation, no view row, no actions.
  private readonly legacyNames = new Map<number, string>()

  constructor(private readonly bw: WindowLookup) {}

  bindSession = (winId: number, sessionId: string): void => {
    this.widgetOf.set(winId, sessionId)
  }

  bindLegacy = (winId: number, name: string): void => {
    this.legacyNames.set(winId, name)
  }

  setPending = (winId: number, pending: PendingCreate): void => {
    this.pendingCreates.set(winId, pending)
  }

  pending = (winId: number): PendingCreate | undefined => this.pendingCreates.get(winId)

  clearPending = (winId: number): void => {
    this.pendingCreates.delete(winId)
  }

  sessionOf = (winId: number): string | undefined => this.widgetOf.get(winId)

  legacyOf = (winId: number): string | undefined => this.legacyNames.get(winId)

  hasSession = (winId: number): boolean => this.widgetOf.has(winId)

  hasLegacy = (winId: number): boolean => this.legacyNames.has(winId)

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

  forLegacy = (name: string): BrowserWindow | undefined => {
    for (const [winId, legacy] of this.legacyNames) {
      if (legacy !== name) continue
      const win = this.bw.fromId(winId)
      if (win && !win.isDestroyed()) return win
    }
    return undefined
  }

  /** A copy, so callers may destroy windows while walking it. */
  legacyEntries = (): [number, string][] => [...this.legacyNames]

  /** Every live window bound to a Tether session. */
  sessionWindows = (): BrowserWindow[] =>
    this.bw.getAllWindows().filter((w) => !w.isDestroyed() && this.widgetOf.has(w.id))

  /** The window an IPC sender belongs to, if any (untrusted sender). */
  senderWindow = (sender: WebContents): BrowserWindow | null => this.bw.fromWebContents(sender)

  /** The session a renderer's window shows, if any (untrusted IPC sender). */
  senderSession = (sender: WebContents): string | undefined => {
    const win = this.bw.fromWebContents(sender)
    return win ? this.widgetOf.get(win.id) : undefined
  }

  forget = (winId: number): void => {
    this.widgetOf.delete(winId)
    this.legacyNames.delete(winId)
    this.pendingCreates.delete(winId)
  }
}
