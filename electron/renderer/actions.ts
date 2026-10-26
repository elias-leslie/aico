// The action registry: the single source of truth for every Aico capability.
// Every discoverability surface — the lantern menu, the pinned titlebar cluster,
// and the command palette — is a *view* over this one list, so a new capability
// shows up everywhere by adding one entry here.
//
// An action is pinnable when a click does something: it runs directly, opens a
// workspace picker, or opens one of the top-level menu flyouts. Reference entries
// are listed for discoverability but not clickable (e.g. copy/paste are terminal
// chords); they still show their shortcut so users learn them.

import type { SelectionToast } from '../types'
import { chordLabel } from './chords'

// Late-bound so the `palette` action can open the palette without this module
// importing the control surface (which imports this module).
let paletteOpener: () => void = () => {}
export function setPaletteOpener(fn: () => void): void {
  paletteOpener = fn
}

export const AICO_TOAST_EVENT = 'aico:toast'

export type AicoToastDetail = SelectionToast

function showToast(detail: AicoToastDetail): void {
  window.dispatchEvent(new CustomEvent<AicoToastDetail>(AICO_TOAST_EVENT, { detail }))
}

/** Open a Tether session in a window: the one path behind every row of the
 * "Open session" flyout. A refusal shows the safe text toast. */
export async function openExistingSession(id: string): Promise<void> {
  try {
    await window.aico.actions.openSession(id)
  } catch (error) {
    console.warn('[aico] failed to open session:', error)
    showToast({ kind: 'Error', snippet: 'Could not open session' })
  }
}

/** Copy a stable, human-readable snapshot rather than leaking an unhandled IPC
 * rejection into the renderer. Both outcomes use the existing safe text toast. */
export async function copySessionDiagnostics(): Promise<void> {
  try {
    const diagnostics = await window.aico.actions.sessionDiagnostics()
    window.aico.clipboard.write(JSON.stringify(diagnostics, null, 2))
    showToast({ kind: 'Copied', snippet: 'Session diagnostics' })
  } catch (error) {
    console.warn('[aico] failed to copy session diagnostics:', error)
    showToast({ kind: 'Error', snippet: 'Could not copy session diagnostics' })
  }
}

/** Set a check-in on this session; the toast says when, or why not. */
export async function checkInLater(dueAt: number): Promise<void> {
  try {
    const time = await window.aico.actions.checkIn(dueAt)
    showToast({ kind: 'Check-in', snippet: `Set for ${time}` })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : ''
    showToast({ kind: 'Error', snippet: message || 'Could not set the check-in' })
  }
}

export async function cancelCheckIn(wakeId: string, time: string): Promise<void> {
  try {
    await window.aico.actions.cancelCheckIn(wakeId)
    showToast({ kind: 'Check-in', snippet: `Cancelled ${time}` })
  } catch {
    showToast({ kind: 'Error', snippet: 'Could not cancel the check-in' })
  }
}

async function endCurrentSession(): Promise<void> {
  try {
    await window.aico.actions.endSession()
  } catch (error) {
    console.warn('[aico] failed to end session:', error)
    showToast({ kind: 'Error', snippet: 'Could not confirm End; check the session list' })
  }
}

const COORDINATOR_LABELS = { on: 'Unmark as coordinator', off: 'Mark as coordinator' }

/** Name the coordinator toggle for this window's current state. */
export function setCoordinatorAction(on: boolean): void {
  const action = ACTIONS.find((a) => a.id === 'coordinator')
  if (action) action.label = on ? COORDINATOR_LABELS.on : COORDINATOR_LABELS.off
  const row = document.querySelector('.aico-row[data-id="coordinator"] .aico-lbl')
  if (row && action) row.textContent = action.label
}

export interface Action {
  id: string
  /** Group header in the menu, in first-seen order. */
  section: string
  label: string
  /** Human-readable shortcut, e.g. "Ctrl+Shift+Space", or a CLI verb for
   * references; always read from the keys actually bound (chords.ts, or the
   * global hotkey main registered), never written by hand. */
  shortcut: string
  /** Single glyph shown in the cluster/menu/palette. */
  icon: string
  /** Optional accent (Lantern palette); tints the icon — used by per-TUI launchers. */
  accent?: string
  /** Optional static SVG mark from the TUI spec, shown in place of `icon` so
   * each per-TUI launcher reads as its tool at a glance. */
  svg?: string
  /** Optional one-line explainer shown in the hover tooltip. */
  note?: string
  /** Present ⇒ runnable from a click and eligible to be pinned. */
  run?: () => void
  /** True for launchers that need a workspace before they can run (the per-TUI
   * "New <TUI>" entries). They have no `run`: clicking instead pops the picker,
   * which performs the launch. Still pinnable + palette-searchable. */
  picksProject?: boolean
  /** True for top-level menu hosts that open a flyout and can be pinned as
   * dropdown buttons in the titlebar. */
  opensFlyout?: boolean
}

export const ACTIONS: Action[] = [
  {
    id: 'indicate',
    section: 'Capture',
    label: 'Indicate selection',
    shortcut: '',
    icon: '⊹',
    note: 'Pull the latest captured text or image into this session.',
    run: () => window.aico.actions.indicate(),
  },
  {
    // Flyout-only host (no run): hovering opens the "New widget" picker — the TUI
    // list, each TUI drilling into a workspace to launch in. A launch always
    // names both, so there's no default fast path.
    id: 'new-widget',
    section: 'Session',
    label: 'New session',
    shortcut: '',
    icon: '＋',
    opensFlyout: true,
  },
  {
    // Flyout-only host (no run): hovering opens the "Replace with <TUI>" picker,
    // which runs in the focused widget. No default action — replacing is
    // destructive, so the user must pick a specific TUI.
    id: 'replace-tui',
    section: 'Session',
    label: 'Restart with another tool',
    shortcut: '',
    icon: '⟳',
    opensFlyout: true,
  },
  {
    id: 'hub',
    section: 'Session',
    label: 'Show windows',
    shortcut: chordLabel('hub'),
    icon: '⊞',
    run: () => window.aico.actions.hub(),
  },
  {
    id: 'palette',
    section: 'Session',
    label: 'Command palette',
    shortcut: chordLabel('palette'),
    icon: '⌕',
    run: () => paletteOpener(),
  },
  {
    id: 'rename',
    section: 'Session',
    label: 'Rename session',
    shortcut: '',
    icon: '✎',
    note: 'Same as clicking the title. An empty name goes back to the default.',
    run: () => window.dispatchEvent(new CustomEvent('aico:rename')),
  },
  {
    id: 'refresh',
    section: 'Session',
    label: 'Refresh terminal',
    shortcut: chordLabel('refresh'),
    icon: '↻',
    note: 'Repaint the view from tmux if output looks garbled or duplicated.',
    run: () => window.dispatchEvent(new CustomEvent('aico:refresh')),
  },
  {
    // Flyout-only host (no run): hovering opens the "Open workspace ▸" picker.
    // Each choice rebinds THIS widget and respawns its pane there; it does not
    // move the global `st` pointer. Destructive (restarts the agent), so no
    // default action — the user picks a specific workspace.
    id: 'switch-project',
    section: 'Session',
    label: 'Restart in project',
    shortcut: '',
    icon: '⇄',
    opensFlyout: true,
  },
  {
    id: 'attach-tmux',
    section: 'Session',
    label: 'Open session',
    shortcut: '',
    icon: '⇱',
    opensFlyout: true,
  },
  {
    // Flyout-only host (no run): the quick times from Tether's wake policy and
    // this session's pending check-ins, each with Cancel.
    id: 'check-in-later',
    section: 'Session',
    label: 'Check in later',
    shortcut: '',
    icon: '◷',
    note: 'At that time the agent is asked where things stand, once it is idle and you are not typing.',
    opensFlyout: true,
  },
  {
    id: 'coordinator',
    section: 'Session',
    label: COORDINATOR_LABELS.off,
    shortcut: '',
    icon: '⚑',
    note: 'A coordinator has a Coordinator label in its titlebar and tiles in the centre column.',
    run: () => window.aico.actions.toggleCoordinator(),
  },
  {
    id: 'copy-session-diagnostics',
    section: 'Session',
    label: 'Copy session diagnostics',
    shortcut: '',
    icon: 'ⓘ',
    note: "Copy this session's ownership, tmux, resource, and warning snapshot as formatted JSON.",
    run: () => void copySessionDiagnostics(),
  },
  {
    id: 'retire-widget',
    section: 'Session',
    label: 'End session',
    shortcut: '', // destructive (ends the tmux session) — no chord, to avoid accidents
    icon: '⏏',
    run: () => void endCurrentSession(),
  },
  {
    id: 'copy',
    section: 'Edit',
    label: 'Copy selection',
    shortcut: chordLabel('copy'),
    icon: '⧉',
  },
  {
    id: 'compose',
    section: 'Edit',
    label: 'Compose text',
    shortcut: '',
    icon: '¶',
    note: 'Correct a draft before inserting it into this session.',
    run: () => window.dispatchEvent(new CustomEvent('aico:compose-open')),
  },
  {
    id: 'paste',
    section: 'Edit',
    label: 'Paste',
    shortcut: chordLabel('paste'),
    icon: '⎘',
  },
  {
    id: 'arcade-next',
    section: 'Titlebar',
    label: 'Next game',
    shortcut: '',
    icon: '🕹',
    note: 'Swap the titlebar game for one this window hasn’t shown yet.',
    run: () => window.dispatchEvent(new CustomEvent('aico:arcade-next')),
  },
  {
    // Flyout-only host (no run): hovering opens the game list; a choice swaps
    // this window's titlebar game.
    id: 'arcade-pick',
    section: 'Titlebar',
    label: 'Choose game',
    shortcut: '',
    icon: '🎮',
    opensFlyout: true,
  },
  {
    id: 'arcade-toggle',
    section: 'Titlebar',
    label: 'Turn games on or off',
    shortcut: '',
    icon: '⊘',
    note: 'Stops the titlebar games in every window to save CPU and memory. Run again to bring them back.',
    run: () => window.aico.arcade.toggle(),
  },
]

// Per-TUI launch actions, built from the registry at init (the TUI list lives in
// the main process, fetched over IPC). They are runnable ⇒ pinnable and palette-
// searchable. They are NOT added to ACTIONS, so the lantern menu renders them
// only inside the "New widget" flyout — not as separate rows.
let tuiActions: Action[] = []

/** Build the per-TUI actions from the enabled TUIs (slug/label/accent): for each,
 * a "New <TUI>" launcher (picks a workspace, then opens a new widget) and a
 * "Replace with <TUI>" launcher (runs in the focused widget, replacing whatever's there).
 * Both are pinnable. */
export function setTuiActions(
  tuis: { slug: string; displayName: string; accent: string; icon?: string }[],
): void {
  tuiActions = tuis.flatMap((t) => [
    {
      id: `new:${t.slug}`,
      section: 'Session',
      label: `New ${t.displayName} session`,
      shortcut: '', // launched from the flyout / a pinned icon — no chord
      icon: '＋',
      accent: t.accent,
      svg: t.icon,
      // No run: clicking pops the workspace picker (the menu drill-down / pinned
      // icon), which calls newWidget(slug, projectId) once a project is chosen.
      picksProject: true,
    },
    {
      id: `replace:${t.slug}`,
      section: 'Session',
      label: `Restart with ${t.displayName}`,
      shortcut: '', // destructive (ends the current pane) — no chord
      icon: '⟳',
      accent: t.accent,
      svg: t.icon,
      run: () => window.aico.actions.loadTui(t.slug),
    },
  ])
}

// Per-project launch actions, built from the Aico project catalog at init
// (fetched over IPC). Each rebinds the focused widget and respawns its pane
// there. Runnable ⇒ pinnable + palette-searchable. Like tuiActions, they are NOT
// in ACTIONS, so they appear only inside the "Open workspace" flyout, never as rows.
let projectActions: Action[] = []

/** Build the per-workspace actions from the catalog: an "Open <Name>" launcher
 * for each, running in (and rebinding) the focused widget. All are pinnable. */
export function setProjectActions(
  projects: { id: string; name: string; current: boolean }[],
): void {
  projectActions = projects.map((p) => ({
    id: `project:${p.id}`,
    section: 'Session',
    label: `Restart in ${p.name}`,
    shortcut: '', // launched from the flyout / a pinned icon — no chord
    icon: '⇄',
    run: () => window.aico.actions.switchProject(p.id),
  }))
}

// Per-game actions ("Play <Game>"), one for each titlebar game this build
// ships. Like the launchers above, they appear only inside their flyout.
let gameActions: Action[] = []
let gameList: { key: string; name: string }[] = []

/** The titlebar games, by name, for the "Choose game" flyout. */
export const listGames = (): { key: string; name: string }[] => gameList

export function setGameActions(games: { key: string; name: string }[]): void {
  gameList = games
  gameActions = games.map((g) => ({
    id: `game:${g.key}`,
    section: 'Titlebar',
    label: `Play ${g.name}`,
    shortcut: '',
    icon: '🕹',
    run: () => window.dispatchEvent(new CustomEvent('aico:arcade-pick', { detail: g.key })),
  }))
}

/** The static registry plus the dynamic per-TUI, per-project and per-game
 * launchers — what findAction, the palette, and the pin set resolve over (the
 * menu uses ACTIONS). Sessions are not actions: the "Open session" flyout lists
 * them live, so there is one way to open one. */
export function allActions(): Action[] {
  return [...ACTIONS, ...tuiActions, ...projectActions, ...gameActions]
}

/** A capability is pinnable when a click does something: it runs directly, pops
 * the workspace picker that runs it, or opens a top-level menu flyout. */
export const isPinnable = (a: Action): boolean =>
  typeof a.run === 'function' || a.picksProject === true || a.opensFlyout === true

export function findAction(id: string): Action | undefined {
  return allActions().find((a) => a.id === id)
}

/** Run an action by id (no-op for reference-only or unknown ids). */
export function runAction(id: string): void {
  findAction(id)?.run?.()
}

/** Section headers in first-seen order. */
export function sections(): string[] {
  return [...new Set(ACTIONS.map((a) => a.section))]
}

/** Seeded on first run, before the user customizes anything. */
export const DEFAULT_PINS = ['indicate']

/** The pinned actions to show, in pin order: ids whose feature is unavailable
 * right now (a TUI or project the catalog did not list, games not loaded, a
 * retired action) and repeats are skipped. Display only: showing pins never
 * changes the stored list, so a pin comes back as soon as its action does. */
export function pinnedActions(pins: string[]): Action[] {
  const seen = new Set<string>()
  const shown: Action[] = []
  for (const id of pins) {
    if (seen.has(id)) continue
    seen.add(id)
    const a = findAction(id)
    if (a && isPinnable(a)) shown.push(a)
  }
  return shown
}

/** Id families built at runtime from Tether's tools, the project catalog and
 * the loaded games: a pin in one may only be unavailable for now. */
const LAUNCHER_PIN = /^(?:new|replace|project|game):/

/** The pins worth saving: drops repeats and ids that can never show again (a
 * retired action such as `voice`, `grab-*` or an old `session:*` pin), and keeps
 * a launcher pin whose tool, project or game is missing only for now. Applied on
 * every pin, unpin or drag, so dead ids do not pile up against the saved cap. */
export function prunePins(pins: string[]): string[] {
  const seen = new Set<string>()
  return pins.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    const a = findAction(id)
    return a ? isPinnable(a) : LAUNCHER_PIN.test(id)
  })
}

export function togglePin(pins: string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]
}

/** Move pin `from` to where pin `to` sits, by id, so hidden pins between them
 * keep their place; returns the input unchanged when either id is missing. */
export function movePin(pins: string[], from: string, to: string): string[] {
  const i = pins.indexOf(from)
  const j = pins.indexOf(to)
  if (i < 0 || j < 0 || i === j) return pins
  const next = [...pins]
  next.splice(i, 1)
  next.splice(j, 0, from)
  return next
}
