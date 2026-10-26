// GUI channel: Tether forwards show/position/title for views to this GUI after
// fencing the exact running generation under its lifecycle lock. This applies
// one command and says whether it did.

import type { BrowserWindow } from 'electron'
import type { GuiCommand, GuiVerdict, SessionCatalog } from 'tether/client'
import type { PlaceResult } from './compositor'
import type { Bounds } from './views'
import type { Layout } from './window-layout'

interface GuiChannelDeps {
  isQuitting(): boolean
  layout(): Layout | null
  catalog: Pick<SessionCatalog, 'get' | 'upsert'>
  /** Re-list every session (the link's one shared refresh). */
  refresh(): Promise<void>
  focusOrReopen(id: string): void
  /** Reopen a closed window only if this desktop has shown the session, unfocused. */
  reopenIfViewed(id: string): 'open' | 'reopened' | 'no_view'
  forSession(id: string): BrowserWindow | undefined
  /** Place an open window and remember its bounds once it is there. */
  arrange(win: BrowserWindow, bounds: Bounds): Promise<PlaceResult>
  /** The compositor can place windows right now (the desktop bridge is up). */
  canPlace(): boolean
  saveBounds(id: string, bounds: Bounds, displayId: string): void
  /** The display a closed window's bounds land on. */
  displayIdFor(bounds: Bounds): string
  titles(): void
  tray(): void
}

export function createGuiChannel(deps: GuiChannelDeps) {
  const { catalog } = deps

  return async function applyGuiCommand(command: GuiCommand): Promise<GuiVerdict> {
    if (deps.isQuitting()) return { applied: false, error: 'gui_unavailable' }
    if (command.kind === 'layout') {
      const layout = deps.layout()
      return layout ? { applied: true, layout } : { applied: false, error: 'gui_unavailable' }
    }
    let descriptor = catalog.get(command.sessionId)
    if (!descriptor || descriptor.generation !== command.generation) {
      await deps.refresh().catch(() => {})
      descriptor = catalog.get(command.sessionId)
    }
    if (!descriptor) return { applied: false, error: 'not_found' }
    if (descriptor.generation !== command.generation)
      return { applied: false, error: 'stale_generation' }
    const id = command.sessionId
    if (command.kind === 'show') {
      if (!command.ifViewed) deps.focusOrReopen(id)
      else if (deps.reopenIfViewed(id) === 'no_view') return { applied: false, error: 'no_view' }
    } else if (command.kind === 'position' && command.bounds) {
      // Without the compositor there is nowhere to verify a position: say so.
      if (!deps.canPlace()) return { applied: false, error: 'compositor_unavailable' }
      const win = deps.forSession(id)
      if (win) {
        const placed = await deps.arrange(win, command.bounds)
        if (!placed.ok) return { applied: false, error: placed.error }
      } else {
        deps.saveBounds(id, command.bounds, deps.displayIdFor(command.bounds))
      }
    } else if (command.kind === 'coordinator' && command.coordinator !== undefined) {
      // Tether records the mark once this view applied it and then sends
      // `session.updated`; show it now.
      catalog.upsert({ ...descriptor, coordinator: command.coordinator })
      deps.titles()
    } else if (command.kind === 'title' && command.label !== undefined) {
      // Tether renames the session once this view applied the title.
      catalog.upsert({ ...descriptor, name: command.label, label: command.label })
      deps.titles()
      deps.tray()
    } else {
      return { applied: false, error: 'invalid_body' }
    }
    return { applied: true }
  }
}
