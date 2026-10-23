// The selection bus, main's half: the session a selection goes to, and typing
// it there through Tether. Sends arrive from the loopback listener (browser
// extension, `st selection send`); the indicate hotkey re-sends the newest
// capture, which is kept in memory only.

import type { IpcMain } from 'electron'
import { type SessionCatalog, type TetherClient, TetherError } from 'tether/client'
import { compactRef, type SelectionRecord } from './selection'
import type { ViewRow } from './views'
import type { WindowRegistry } from './window-registry'

/** What became of a send: typed at a session prompt, or why not. */
export type SelectionDelivery =
  | { delivered: true; reason: null }
  | {
      delivered: false
      /** empty | no_session | busy | session_changing | stale_generation | insert_failed */
      reason: string
    }

interface SelectionBusDeps {
  registry: Pick<WindowRegistry, 'forSession'>
  catalog: Pick<SessionCatalog, 'get'>
  listViews(): ViewRow[]
  tether: Pick<TetherClient, 'inject'>
  isReplacing(id: string): boolean
  isQuitting(): boolean
}

const refused = (reason: string): SelectionDelivery => ({ delivered: false, reason })

export function createSelectionBus(deps: SelectionBusDeps) {
  const { registry, catalog } = deps

  const inFlight = new Set<string>()
  // The widget that should receive a selection: the last Aico widget the user
  // focused. (During a browser send the *browser* holds OS focus, so "active
  // session" means most-recently-focused widget, not focused-now.)
  let lastFocusedAico: string | null = null
  // The newest capture, for the indicate hotkey. Never written to disk.
  let newest: SelectionRecord | null = null

  // The last-focused session if its window is still open, else the most
  // recently opened view.
  function selectionTarget(): string | undefined {
    if (lastFocusedAico && registry.forSession(lastFocusedAico)) return lastFocusedAico
    const open = deps.listViews().filter((view) => registry.forSession(view.id))
    return open.length ? open[open.length - 1].id : undefined
  }

  // Shared deliver path for every trigger: type one compact reference at the
  // target session's prompt through Tether's generation-fenced inject (no Enter;
  // the user adds their ask and submits), then show the window and toast it.
  // Tether refuses a stale generation or a stopped session; nothing is retried.
  async function deliver(records: SelectionRecord[]): Promise<SelectionDelivery> {
    const usable = records.filter((record) => record?.kind && record.kind !== 'empty')
    if (!usable.length) return refused('empty')
    newest = usable[usable.length - 1]
    const targetId = selectionTarget()
    if (!targetId) return refused('no_session')
    const win = registry.forSession(targetId)
    if (inFlight.has(targetId)) {
      win?.webContents.send('selection:toast', {
        kind: 'Selection not inserted',
        snippet: 'Another selection is still being inserted. Try again.',
      })
      return refused('busy')
    }
    const descriptor = catalog.get(targetId)
    if (!win || !descriptor || deps.isReplacing(targetId)) {
      win?.webContents.send('selection:toast', {
        kind: 'Session changing',
        snippet: 'Selection was not inserted while the terminal was being replaced.',
      })
      return refused('session_changing')
    }
    const isCurrent = (): boolean =>
      !deps.isQuitting() &&
      !win.isDestroyed() &&
      registry.forSession(targetId) === win &&
      catalog.get(targetId)?.generation === descriptor.generation
    if (!isCurrent()) return refused('session_changing')
    inFlight.add(targetId)
    try {
      await deps.tether.inject(targetId, descriptor.generation, compactRef(usable), 'type')
    } catch (error) {
      console.warn('[aico] selection insert failed:', error)
      const stale = error instanceof TetherError && error.code === 'stale_generation'
      if (!win.isDestroyed()) {
        win.webContents.send('selection:toast', {
          kind: 'Selection not inserted',
          snippet: stale
            ? 'The session changed. Try again.'
            : 'Tether could not insert the selection.',
        })
      }
      return refused(stale ? 'stale_generation' : 'insert_failed')
    } finally {
      inFlight.delete(targetId)
    }
    if (isCurrent()) {
      win.show()
      win.focus()
      const head = usable[0]
      win.webContents.send('selection:toast', {
        kind: usable.length > 1 ? `${usable.length} items` : head.kind,
        snippet: usable.length > 1 ? usable.map((r) => r.snippet ?? '').join(' · ') : head.snippet,
      })
    }
    return { delivered: true, reason: null }
  }

  // "Indicate" (hotkey or menu): send the newest capture again, to whichever
  // session is the target now.
  async function selectionGrab(): Promise<void> {
    if (newest) await deliver([newest])
  }

  return {
    /** Type captures at the target session; resolves what became of them. */
    deliver,
    /** The indicate hotkey and menu item: re-send the newest capture. */
    grab: selectionGrab,
    /** The session a selection goes to. */
    target: selectionTarget,
    /** A window gained focus; a window with no session keeps the last target. */
    noteFocus: (sessionId: string | undefined): void => {
      lastFocusedAico = sessionId ?? lastFocusedAico
    },
    registerIpc: (ipcMain: Pick<IpcMain, 'on'>): void => {
      ipcMain.on('selection:grab', () => void selectionGrab())
    },
  }
}
