import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

// Lantern orb tray icon, three states: muted idle / amber active (at least one
// widget is thinking) / amber with a red badge, "needs you" (a session is
// blocked on the owner and its window is unfocused; it wins). PNGs are generated from the selected SVG by
// scripts/gen-tray-icons.mjs. Resolved relative to out/main at runtime.
const iconsDir = join(__dirname, '../../assets/tray')
const idleImage = nativeImage.createFromPath(join(iconsDir, 'idle.png'))
const activeImage = nativeImage.createFromPath(join(iconsDir, 'active.png'))
const needsYouImage = nativeImage.createFromPath(join(iconsDir, 'needs-you.png'))

export type TrayGroup = 'needs-you' | 'finished' | 'working' | 'idle'

export interface TrayWidget {
  id: string
  label: string
  open: boolean
  /** Attention group (attention.ts); the menu lists groups most-urgent first. */
  group?: TrayGroup
  /** State and age, e.g. `waiting 3m`. */
  detail?: string | null
}

const GROUP_TITLES: readonly [TrayGroup, string][] = [
  ['needs-you', 'Needs you'],
  ['finished', 'Finished'],
  ['working', 'Working'],
  ['idle', 'Idle'],
]

/** A launchable TUI as the tray sees it (slug + menu label), from the registry. */
export interface NewWidgetTool {
  slug: string
  label: string
}

/** A workspace the New-widget submenu can launch into (slug + display name). */
export interface NewWidgetProject {
  id: string
  name: string
}

export interface TrayHandlers {
  /** Focus the widget if open, otherwise reopen it (reattach + restore bounds). */
  onSelect: (id: string) => void
  /** End the session through Tether (after confirmation). */
  onDiscard: (id: string) => void
  /** Create a new widget running the chosen TUI in the chosen workspace. */
  onNewWidget: (tool: string, projectId: string) => void
  /** Re-list sessions from Tether and rebuild the menu. */
  onRefreshSessions: () => void
  onHubView: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null
let tools: NewWidgetTool[] = []
let projects: NewWidgetProject[] = []
let unavailable: string | null = null
const thinking = new Set<number>()
let needsYou = false
/** Some session's agent is working (Tether's state). */
let agentsWorking = false
/** What the published menu was built from. Linux replaces the whole native
 * menu on setContextMenu and collapses one the owner has open, so an
 * unchanged catalog must not republish it. */
let menuKey = ''
/** True while the native menu is open; changes wait for it to close, since
 * republishing it collapses the open menu and its submenus. */
let menuOpen = false
let menuOpenTimer: NodeJS.Timeout | null = null
let pendingWidgets: TrayWidget[] | null = null

/** Publish `menu`, tracking when the owner has it open. */
function publishMenu(menu: Menu): void {
  if (typeof menu.on === 'function') {
    menu.on('menu-will-show', () => {
      console.log('[aico:tray] menu-will-show')
      menuOpen = true
      // A close the desktop never reports must not freeze the menu for good.
      if (menuOpenTimer) clearTimeout(menuOpenTimer)
      menuOpenTimer = setTimeout(menuClosed, 60_000)
      menuOpenTimer.unref?.()
    })
    menu.on('menu-will-close', () => {
      console.log('[aico:tray] menu-will-close')
      menuClosed()
    })
  }
  tray?.setContextMenu(menu)
}

function menuClosed(): void {
  menuOpen = false
  if (menuOpenTimer) clearTimeout(menuOpenTimer)
  menuOpenTimer = null
  const widgets = pendingWidgets
  pendingWidgets = null
  if (widgets) publishIfChanged(widgets)
}

function publishIfChanged(widgets: TrayWidget[]): void {
  const key = JSON.stringify([widgets, tools, projects, unavailable])
  if (key === menuKey) return
  if (menuOpen) {
    pendingWidgets = widgets
    return
  }
  console.log(
    '[aico:tray] republish',
    JSON.stringify(widgets.map((w) => [w.label.slice(0, 18), w.group, w.detail, w.open])),
  )
  menuKey = key
  publishMenu(buildMenu(widgets))
}

function buildMenu(widgets: TrayWidget[]): Menu {
  const h = handlers
  if (!h) return Menu.buildFromTemplate([])
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(unavailable
      ? [{ label: unavailable, enabled: false }, { type: 'separator' as const }]
      : []),
  ]
  // Every session, grouped most-urgent first (widgets arrive sorted). A row
  // opens or focuses its window; ● marks an open window, ○ a closed one.
  for (const [group, title] of GROUP_TITLES) {
    const rows = widgets.filter((w) => (w.group ?? 'idle') === group)
    if (!rows.length) continue
    template.push({ label: title, enabled: false })
    for (const w of rows) {
      template.push({
        label: `${w.open ? '●' : '○'} ${w.label}${w.detail ? ` — ${w.detail}` : ''}`,
        click: () => h.onSelect(w.id),
      })
    }
  }
  if (!widgets.length) template.push({ label: 'No sessions', enabled: false })
  template.push({ type: 'separator' })

  template.push(
    // Two-level submenu: TUI (from the registry) ▸ workspace (Aico Personal
    // Workspace + `st` projects). A launch is always an explicit pair. A new tool
    // appears here by adding its spec, with no tray edits.
    {
      label: 'New session',
      submenu: tools.map((t) => ({
        label: t.label,
        submenu: projects.length
          ? projects.map((p) => ({ label: p.name, click: () => h.onNewWidget(t.slug, p.id) }))
          : [{ label: 'No projects', enabled: false }],
      })),
    },
    {
      label: 'Refresh sessions',
      click: () => h.onRefreshSessions(),
    },
    // Phase 1 replaces this with the dimmed cascade grid; for now, surface all.
    { label: 'Show windows', click: () => h.onHubView() },
  )

  if (widgets.length) {
    template.push(
      { type: 'separator' },
      {
        label: 'End session',
        submenu: widgets.map((w) => ({ label: w.label, click: () => h.onDiscard(w.id) })),
      },
    )
  }

  template.push(
    { type: 'separator' },
    { label: 'Quit Aico (sessions continue)', click: () => app.quit() },
  )
  return Menu.buildFromTemplate(template)
}

export function createTray(
  h: TrayHandlers,
  newWidgetTools: NewWidgetTool[],
  newWidgetProjects: NewWidgetProject[],
): void {
  handlers = h
  tools = newWidgetTools
  projects = newWidgetProjects
  // createFromPath returns an empty image instead of throwing, which would
  // leave a blank tray slot. Say so; the packaged smoke fails on this line.
  if (idleImage.isEmpty() || activeImage.isEmpty() || needsYouImage.isEmpty()) {
    console.error(`[aico] tray icon failed to load from ${iconsDir}`)
  }
  tray = new Tray(idleImage)
  tray.setToolTip('Aico')
  publishMenu(buildMenu([]))
  menuKey = ''
  shownIcon = 'idle'
}

/** Rebuild the menu from Tether's session catalog (open + closed views), the
 * tool registry and the workspace catalog. `notice` explains an unreachable
 * Tether at the top of the menu; sessions keep running meanwhile. */
export function refreshTray(
  widgets: TrayWidget[],
  newWidgetTools: NewWidgetTool[],
  newWidgetProjects: NewWidgetProject[],
  notice: string | null = null,
): void {
  tools = newWidgetTools
  projects = newWidgetProjects
  unavailable = notice
  agentsWorking = widgets.some((w) => w.group === 'working')
  publishIfChanged(widgets)
  syncIcon()
}

/** Track per-window thinking state; the icon goes amber while any is active. */
export function setWidgetActivity(winId: number, active: boolean): void {
  if (active) thinking.add(winId)
  else thinking.delete(winId)
  syncIcon()
}

/** Show or clear the "needs you" icon (see attention.ts). */
export function setNeedsYou(on: boolean): void {
  needsYou = on
  syncIcon()
}

export type TrayIcon = 'idle' | 'active' | 'needs-you'

export function trayIcon(): TrayIcon {
  if (needsYou) return 'needs-you'
  return thinking.size > 0 || agentsWorking ? 'active' : 'idle'
}

/** The icon last published. Each setImage/setToolTip makes the Linux tray
 * re-announce the item and close a menu the owner has open, and activity
 * toggles arrive several times a second, so publish only a change. */
let shownIcon: TrayIcon | null = null

function syncIcon(): void {
  const icon = trayIcon()
  if (!tray || icon === shownIcon) return
  shownIcon = icon
  tray.setImage(icon === 'needs-you' ? needsYouImage : icon === 'active' ? activeImage : idleImage)
  tray.setToolTip(icon === 'needs-you' ? 'Aico: a session needs you' : 'Aico')
}
