import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

// Lantern orb tray icon, two states: muted idle / amber active (active = at
// least one widget is thinking). PNGs are generated from the selected SVG by
// scripts/gen-tray-icons.mjs. Resolved relative to out/main at runtime.
const iconsDir = join(__dirname, '../../assets/tray')
const idleImage = nativeImage.createFromPath(join(iconsDir, 'idle.png'))
const activeImage = nativeImage.createFromPath(join(iconsDir, 'active.png'))

export interface TrayWidget {
  id: string
  label: string
  open: boolean
}

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

export interface AttachableTmuxSession {
  id: string
  label: string
  source: string
}

export interface TrayHandlers {
  /** Focus the widget if open, otherwise reopen it (reattach + restore bounds). */
  onSelect: (id: string) => void
  /** Kill the widget's tmux session and forget it. */
  onDiscard: (id: string) => void
  /** Create a new widget running the chosen TUI in the chosen workspace. */
  onNewWidget: (tool: string, projectId: string) => void
  /** Attach an externally-owned tmux session as a widget. */
  onAttachTmuxSession: (id: string) => void
  onHubView: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null
let tools: NewWidgetTool[] = []
let projects: NewWidgetProject[] = []
let attachables: AttachableTmuxSession[] = []
const thinking = new Set<number>()

function buildMenu(widgets: TrayWidget[]): Menu {
  const h = handlers
  if (!h) return Menu.buildFromTemplate([])
  const open = widgets.filter((w) => w.open)
  const closed = widgets.filter((w) => !w.open)

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(open.length
      ? open.map((w) => ({ label: `● ${w.label}`, click: () => h.onSelect(w.id) }))
      : [{ label: 'No widgets open', enabled: false }]),
    { type: 'separator' },
  ]

  if (closed.length) {
    template.push({
      label: 'Reopen',
      submenu: closed.map((w) => ({ label: w.label, click: () => h.onSelect(w.id) })),
    })
  }

  template.push(
    // Two-level submenu: TUI (from the registry) ▸ workspace (Aico Personal
    // Workspace + `st` projects). A launch is always an explicit pair. A new tool
    // appears here by adding its spec, with no tray edits.
    {
      label: 'New widget',
      submenu: tools.map((t) => ({
        label: t.label,
        submenu: projects.length
          ? projects.map((p) => ({ label: p.name, click: () => h.onNewWidget(t.slug, p.id) }))
          : [{ label: 'No workspaces', enabled: false }],
      })),
    },
    {
      label: 'Attach tmux session',
      submenu: attachables.length
        ? attachables.map((s) => ({
            label: `${s.source}: ${s.label}`,
            click: () => h.onAttachTmuxSession(s.id),
          }))
        : [{ label: 'No attachable sessions', enabled: false }],
    },
    // Phase 1 replaces this with the dimmed cascade grid; for now, surface all.
    { label: 'Hub view', click: () => h.onHubView() },
  )

  if (widgets.length) {
    template.push(
      { type: 'separator' },
      {
        label: 'Discard',
        submenu: widgets.map((w) => ({ label: w.label, click: () => h.onDiscard(w.id) })),
      },
    )
  }

  template.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() })
  return Menu.buildFromTemplate(template)
}

export function createTray(
  h: TrayHandlers,
  newWidgetTools: NewWidgetTool[],
  newWidgetProjects: NewWidgetProject[],
  attachableTmuxSessions: AttachableTmuxSession[],
): void {
  handlers = h
  tools = newWidgetTools
  projects = newWidgetProjects
  attachables = attachableTmuxSessions
  tray = new Tray(idleImage)
  tray.setToolTip('Aico')
  tray.setContextMenu(buildMenu([]))
}

/** Rebuild the menu from the current widget catalog (open + closed) and the
 * current workspace catalog (the New-widget submenu's second level). */
export function refreshTray(
  widgets: TrayWidget[],
  newWidgetProjects: NewWidgetProject[],
  attachableTmuxSessions: AttachableTmuxSession[],
): void {
  projects = newWidgetProjects
  attachables = attachableTmuxSessions
  tray?.setContextMenu(buildMenu(widgets))
}

/** Track per-window thinking state; the icon goes amber while any is active. */
export function setWidgetActivity(winId: number, active: boolean): void {
  if (active) thinking.add(winId)
  else thinking.delete(winId)
  tray?.setImage(thinking.size > 0 ? activeImage : idleImage)
}
