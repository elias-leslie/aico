// Titlebars and the tray: what every window's titlebar shows (name, tool mark,
// coordinator chip, context badge) and the tray menu of sessions, tools and
// workspaces. Both change only on Tether events and Aico actions.

import type { BrowserWindow, IpcMain } from 'electron'
import {
  type ContextHook,
  type SessionCatalog,
  type SessionDescriptor,
  type TetherTool,
  wakePendingTime,
} from 'tether/client'
import { type Attention, groupRows } from './attention'
import type { ProjectCatalog } from './project'
import { coordinatorChip, sessionTitle, toolDisplayName, traySessionLabel } from './session-catalog'
import { toolMark } from './tool-marks'
import type { createTray, refreshTray, setWidgetActivity, TrayHandlers, TrayWidget } from './tray'
import type { WindowRegistry } from './window-registry'

interface WindowChromeDeps {
  registry: Pick<WindowRegistry, 'sessionOf' | 'forSession' | 'senderWindow' | 'all'>
  catalog: Pick<SessionCatalog, 'get' | 'upsert' | 'list'>
  tools(): TetherTool[]
  /** Why session control is unavailable, shown at the top of the tray menu. */
  notice(): string | null
  projects: Pick<ProjectCatalog, 'list'>
  attention: Pick<Attention, 'group'>
  /** Workflow runs and steps as tray rows, and why they may be out of date. */
  runs?: { widgets(): TrayWidget[]; notice(): string | null }
  layout: {
    noteCoordinator(win: BrowserWindow, coordinator: boolean): void
    scheduleWrite(): void
  }
  contextCheck(id: string): Promise<ContextHook | null>
  isQuitting(): boolean
  tray: {
    createTray: typeof createTray
    refreshTray: typeof refreshTray
    setWidgetActivity: typeof setWidgetActivity
  }
  now?: () => number
}

export function createWindowChrome(deps: WindowChromeDeps) {
  const { registry, catalog, projects, attention, layout, tray } = deps
  const now = deps.now ?? Date.now

  function trayTools(): { slug: string; label: string; blankSlate: boolean }[] {
    return deps.tools().map((tool) => ({
      slug: tool.slug,
      label: tool.name,
      blankSlate: tool.blankSlate === true,
    }))
  }

  function syncTray(): void {
    if (deps.isQuitting()) return
    const rows = groupRows(catalog.list(), attention, now())
    const widgets: TrayWidget[] = rows.map(({ item: descriptor, group, detail, at }) => {
      const title = sessionTitle(descriptor)
      const tool = toolDisplayName(descriptor.tool, deps.tools())
      return {
        id: descriptor.id,
        label: traySessionLabel(title, tool),
        title,
        tool,
        open: registry.forSession(descriptor.id) !== undefined,
        group,
        detail,
        at,
        coordinator: descriptor.coordinator === true,
        coordinatorId: descriptor.coordinatorId ?? null,
        parentId: descriptor.parentId ?? null,
        checkIns: (descriptor.wakes ?? []).map((wake) => ({
          id: wake.id,
          time: wakePendingTime(wake.dueAt, now()),
          dueAt: wake.dueAt,
        })),
      }
    })
    tray.refreshTray(
      [...widgets, ...(deps.runs?.widgets() ?? [])],
      trayTools(),
      projects.list(),
      deps.notice(),
      deps.runs?.notice() ?? null,
    )
  }

  // No periodic rebuild: republishing the native menu collapses it while the
  // owner is navigating it. Ages ("waiting 3m") refresh with the next real change
  // and whenever an Aico window gains focus.

  // Push titlebar info to every open window: the session's name (else its
  // workspace, else Tether's label), plus its tool's mark and accent. Changes
  // only on Tether events and Aico actions, so this is event-driven, not polled.
  /** What each window's context badge last showed (`tool|state|detail`). */
  const contextBadges = new Map<number, string>()

  /** Show Tether's context-hook check as the titlebar badge, once per change. */
  function pushContextBadge(win: BrowserWindow, descriptor: SessionDescriptor): void {
    const hook = descriptor.contextHook
    if (!hook) return
    const shown = contextBadges.get(win.id)
    // Not checked yet: keep a badge for the same tool, hide one for another tool.
    if (hook.state === 'unknown') {
      if (shown === undefined || shown.startsWith(`${hook.tool}|`)) return
      contextBadges.set(win.id, `${hook.tool}|unknown|`)
      win.webContents.send('context:mandate', {
        slug: hook.tool,
        state: hook.state,
        detail: hook.detail,
        applicable: false,
      })
      return
    }
    const key = `${hook.tool}|${hook.state}|${hook.detail}`
    if (shown === key) return
    contextBadges.set(win.id, key)
    win.webContents.send('context:mandate', {
      slug: hook.tool,
      state: hook.state,
      detail: hook.detail,
      applicable: hook.applicable,
    })
  }

  /** On window load, show the known badge and ask Tether to check again, as
   * Aico did before Tether owned launches. */
  function refreshContextBadge(win: BrowserWindow): void {
    contextBadges.delete(win.id)
    const id = registry.sessionOf(win.id)
    if (!id) return
    const known = catalog.get(id)
    if (known) pushContextBadge(win, known)
    deps
      .contextCheck(id)
      .then((hook) => {
        const latest = catalog.get(id)
        if (!hook || !latest || win.isDestroyed()) return
        catalog.upsert({ ...latest, contextHook: hook })
        pushContextBadge(win, catalog.get(id) ?? latest)
      })
      .catch(() => {})
  }

  function pushTitles(): void {
    for (const win of registry.all()) {
      if (win.isDestroyed()) continue
      const widgetId = registry.sessionOf(win.id)
      const descriptor = widgetId ? catalog.get(widgetId) : undefined
      if (!descriptor) continue
      const tool = deps.tools().find((candidate) => candidate.slug === descriptor.tool)
      const mark = toolMark(descriptor.tool, tool?.color)
      pushContextBadge(win, descriptor)
      win.webContents.send('win:title', {
        label: sessionTitle(descriptor),
        name: descriptor.name, // prefills the rename input
        icon: mark.icon,
        accent: mark.accent,
        tuiName: tool?.name ?? descriptor.tool,
        tuiSlug: descriptor.tool,
        sessionId: descriptor.tmux.sessionId,
        coordinator: descriptor.coordinator ?? false,
        chip: coordinatorChip(descriptor),
        host: descriptor.host ?? null,
      })
      layout.noteCoordinator(win, descriptor.coordinator ?? false)
    }
    // Names and coordinator marks are in layout.json too; agents read it right
    // after `root title`.
    layout.scheduleWrite()
  }

  return {
    /** Every window's titlebar, then one layout.json write (always, even with no windows). */
    pushTitles,
    /** Rebuild the tray menu; nothing while quitting. */
    syncTray,
    /** A window (re)loaded: resend its badge and ask Tether to check again. */
    refreshContextBadge,
    createTray: (handlers: TrayHandlers): void => {
      tray.createTray(handlers, trayTools(), projects.list())
    },
    /** The window is gone: its thinking mark and last badge. */
    forget: (winId: number): void => {
      tray.setWidgetActivity(winId, false)
      contextBadges.delete(winId)
    },
    registerIpc: (ipcMain: Pick<IpcMain, 'on'>): void => {
      ipcMain.on('win:thinking', (event, on: boolean) => {
        const win = registry.senderWindow(event.sender)
        if (win) tray.setWidgetActivity(win.id, on)
      })
    },
  }
}
