import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import {
  DECISION_LABEL,
  DECISIONS,
  foldTeams,
  laneTitle,
  type RunDecision,
  type RunMember,
  type TeamMember,
  type TeamRow,
  teamMembers,
} from 'tether/client'
import { type AttentionGroup, formatAge } from './attention'
import { BLANK_SLATE_ID, BLANK_SLATE_NAME } from './project'
import { traySessionLabel } from './session-catalog'

// Lantern orb tray icon, three states: muted idle / amber active (at least one
// widget is thinking) / amber with a red badge, "needs you" (a session is
// blocked on the owner and its window is unfocused; it wins). PNGs are generated from the selected SVG by
// scripts/gen-tray-icons.mjs. Resolved relative to out/main at runtime.
const iconsDir = join(__dirname, '../../assets/tray')
const idleImage = nativeImage.createFromPath(join(iconsDir, 'idle.png'))
const activeImage = nativeImage.createFromPath(join(iconsDir, 'active.png'))
const needsYouImage = nativeImage.createFromPath(join(iconsDir, 'needs-you.png'))

export interface TrayWidget {
  id: string
  label: string
  open: boolean
  /** Attention group (attention.ts); Needs you rows head the menu. */
  group?: AttentionGroup
  /** State and age, e.g. `waiting 3m`. */
  detail?: string | null
  /** Pending check-ins, soonest first, with their times (`5:30 PM`). */
  checkIns?: { id: string; time: string; dueAt?: number }[]
  /** Coordinator lineage (tether/client teams.ts): lanes fold under their coordinator. */
  coordinator?: boolean
  coordinatorId?: string | null
  /** When the state began (ms), for ordering within a team. */
  at?: number | null
  /** The session title and tool the label is made of; a lane drops the
   * project its coordinator already names. */
  title?: string
  tool?: string
  /** A workflow run or step (tether/client `RunMember`); it has no window. */
  run?: RunMember
  kind?: TeamMember['kind']
  /** A run's step counts in its own words, in place of the generated team line. */
  summary?: string | null
}

/** What the owner asks of a workflow run or step from the tray. */
export type RunAction =
  | { type: 'open'; url: string }
  | { type: 'resume'; runId: string; stepKey: string | null; action: RunDecision }
  | { type: 'cancel'; runId: string; stepKey: string | null }
  | { type: 'dismiss'; runId: string }

/** A launchable TUI as the tray sees it (slug + menu label), from the registry. */
export interface NewWidgetTool {
  slug: string
  label: string
  /** Offer a Blank Slate session above its workspaces. */
  blankSlate?: boolean
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
  /** Cancel one check-in. */
  onCancelCheckIn: (wakeId: string) => void
  /** Create a new widget running the chosen TUI in the chosen workspace. */
  onNewWidget: (tool: string, projectId: string) => void
  /** Re-list sessions from Tether and rebuild the menu. */
  onRefreshSessions: () => void
  onHubView: () => void
  /** Open, answer, cancel or dismiss a workflow run or step. */
  onRun?: (action: RunAction) => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null
let tools: NewWidgetTool[] = []
let projects: NewWidgetProject[] = []
let unavailable: string | null = null
/** Why the workflow runs may be out of date, or null. */
let runsNotice: string | null = null
const thinking = new Set<number>()
let needsYou = false
/** Some session's agent is working (Tether's state). */
let agentsWorking = false
/** What the published menu was built from. Linux replaces the whole native
 * menu on setContextMenu and collapses one the owner has open, so an
 * unchanged catalog must not republish it. */
let menuKey = ''

type TeamWidget = TrayWidget & TeamMember

const RUN_TITLE_MAX = 48

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `◇ goal — running 4m · 1 working, 2 done` for a run, `· step — tool bash · model · try 1 of 2`. */
function runLabel(w: TeamWidget, run: RunMember, extra: (string | null | undefined)[]): string {
  const age = run.kind === 'run' && w.at ? formatAge(Date.now() - w.at) : null
  const detail = [w.detail ? (age ? `${w.detail} ${age}` : w.detail) : null, ...extra]
    .filter(Boolean)
    .join(' · ')
  return `${run.kind === 'run' ? '◇' : '·'} ${clip(run.title, RUN_TITLE_MAX)}${detail ? ` — ${detail}` : ''}`
}

/** What the owner can do to a run or step: answer a waiting one, cancel, dismiss. */
function runControls(run: RunMember, h: TrayHandlers): Electron.MenuItemConstructorOptions[] {
  const act = (action: RunAction) => () => h.onRun?.(action)
  const what = run.kind === 'run' ? 'run' : 'step'
  const items: Electron.MenuItemConstructorOptions[] = []
  if (run.can.decide) {
    for (const decision of DECISIONS)
      items.push({
        label: `${DECISION_LABEL[decision]} ${what}`,
        click: act({ type: 'resume', runId: run.runId, stepKey: run.stepKey, action: decision }),
      })
  }
  if (run.can.cancel)
    items.push({
      label: `Cancel ${what}`,
      click: act({ type: 'cancel', runId: run.runId, stepKey: run.stepKey }),
    })
  if (run.can.dismiss)
    items.push({ label: 'Dismiss run', click: act({ type: 'dismiss', runId: run.runId }) })
  return items
}

/** A workflow run (a submenu of its steps and controls) or a step. */
function runItem(row: TeamRow<TeamWidget>, h: TrayHandlers): Electron.MenuItemConstructorOptions {
  const w = row.item
  const run = w.run as RunMember
  const open = () => h.onRun?.({ type: 'open', url: run.url })
  const label = runLabel(w, run, [row.summary, row.orphaned ? 'coordinator ended' : null])
  const controls = runControls(run, h)
  if (!row.children.length && !controls.length) return { label, click: open }
  const hint: Electron.MenuItemConstructorOptions[] = run.hint
    ? [{ label: run.hint, enabled: false }]
    : []
  return {
    label,
    submenu: [
      { label: 'Open in Agent Hub', click: open },
      ...(row.children.length
        ? [{ type: 'separator' as const }, ...row.children.map((child) => runItem(child, h))]
        : []),
      ...(controls.length ? [{ type: 'separator' as const }, ...controls] : []),
      ...(hint.length ? [{ type: 'separator' as const }, ...hint] : []),
    ],
  }
}

function rowLabel(
  w: TrayWidget,
  lead: TrayWidget | null,
  extra: (string | null | undefined)[],
): string {
  const name =
    lead && w.title !== undefined && lead.title !== undefined
      ? traySessionLabel(laneTitle(w.title, lead.title), w.tool ?? '')
      : w.label
  const detail = [w.detail, ...extra].filter(Boolean).join(' · ')
  return `${w.open ? '●' : '○'} ${name}${detail ? ` — ${detail}` : ''}`
}

/** One session row, or a coordinator's submenu with its team summary and the
 * team's earliest check-in. */
function teamItem(
  row: TeamRow<TeamWidget>,
  lead: TrayWidget | null,
  h: TrayHandlers,
): Electron.MenuItemConstructorOptions {
  const w = row.item
  if (w.run) return runItem(row, h)
  const own = w.checkIns?.[0] ? `check-in ${w.checkIns[0].time}` : null
  const ended = row.orphaned ? 'coordinator ended' : null
  if (!row.children.length) {
    return { label: rowLabel(w, lead, [own, ended]), click: () => h.onSelect(w.id) }
  }
  const first = teamMembers(row)
    .flatMap((m) => m.checkIns ?? [])
    .reduce<{ time: string; dueAt?: number } | null>(
      (best, c) => (!best || (c.dueAt ?? Infinity) < (best.dueAt ?? Infinity) ? c : best),
      null,
    )
  return {
    label: rowLabel(w, lead, [row.summary, first ? `check-in ${first.time}` : null, ended]),
    submenu: [
      { label: rowLabel(w, lead, [own]), click: () => h.onSelect(w.id) },
      { type: 'separator' },
      ...row.children.map((child) => teamItem(child, w, h)),
    ],
  }
}

function buildMenu(widgets: TrayWidget[]): Menu {
  const h = handlers
  if (!h) return Menu.buildFromTemplate([])
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(unavailable
      ? [{ label: unavailable, enabled: false }, { type: 'separator' as const }]
      : []),
    ...(runsNotice ? [{ label: runsNotice, enabled: false }, { type: 'separator' as const }] : []),
  ]
  // Every session oldest first, with Needs you on top (widgets arrive sorted;
  // working and idle changes never move a row). A row opens or focuses its
  // window; ● marks an open window, ○ a closed one. A coordinator with lanes is
  // a submenu: itself, then its lanes.
  const teams = foldTeams(
    widgets.map((w) => ({
      ...w,
      coordinator: w.coordinator ?? false,
      coordinatorId: w.coordinatorId ?? null,
      group: w.group ?? 'no-status',
      at: w.at ?? null,
      kind: w.kind,
      summary: w.summary ?? null,
    })),
  )
  const waiting = teams.filter((row) => row.group === 'needs-you')
  const rest = teams.filter((row) => row.group !== 'needs-you')
  if (waiting.length) {
    template.push({ label: 'Needs you', enabled: false })
    for (const row of waiting) template.push(teamItem(row, null, h))
    if (rest.length) template.push({ label: 'Other sessions', enabled: false })
  }
  for (const row of rest) template.push(teamItem(row, null, h))
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
        submenu: [
          ...(t.blankSlate
            ? [{ label: BLANK_SLATE_NAME, click: () => h.onNewWidget(t.slug, BLANK_SLATE_ID) }]
            : []),
          ...(projects.length
            ? projects.map((p) => ({ label: p.name, click: () => h.onNewWidget(t.slug, p.id) }))
            : [{ label: 'No projects', enabled: false }]),
        ],
      })),
    },
    {
      label: 'Refresh sessions',
      click: () => h.onRefreshSessions(),
    },
    // Phase 1 replaces this with the dimmed cascade grid; for now, surface all.
    { label: 'Show windows', click: () => h.onHubView() },
  )

  const sessions = widgets.filter((w) => !w.run)
  const checkIns = sessions.flatMap((w) =>
    (w.checkIns ?? []).map((checkIn) => ({ ...checkIn, label: w.label })),
  )
  if (checkIns.length) {
    template.push(
      { type: 'separator' },
      {
        label: 'Check-ins',
        submenu: checkIns.map((checkIn) => ({
          label: `${checkIn.label} — ${checkIn.time}`,
          submenu: [{ label: 'Cancel check-in', click: () => h.onCancelCheckIn(checkIn.id) }],
        })),
      },
    )
  }

  if (sessions.length) {
    template.push(...(checkIns.length ? [] : [{ type: 'separator' as const }]), {
      label: 'End session',
      submenu: sessions.map((w) => ({ label: w.label, click: () => h.onDiscard(w.id) })),
    })
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
  // leave a blank tray slot. Say so in the journal.
  if (idleImage.isEmpty() || activeImage.isEmpty() || needsYouImage.isEmpty()) {
    console.error(`[aico] tray icon failed to load from ${iconsDir}`)
  }
  tray = new Tray(idleImage)
  tray.setToolTip('Aico')
  tray.setContextMenu(buildMenu([]))
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
  runsNote: string | null = null,
): void {
  tools = newWidgetTools
  projects = newWidgetProjects
  unavailable = notice
  runsNotice = runsNote
  agentsWorking = widgets.some((w) => w.group === 'working')
  const key = JSON.stringify([widgets, tools, projects, unavailable, runsNotice])
  if (key !== menuKey) {
    menuKey = key
    tray?.setContextMenu(buildMenu(widgets))
  }
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
