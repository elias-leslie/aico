// The action registry: the single source of truth for every Aico capability.
// Every discoverability surface — the lantern menu, the pinned titlebar cluster,
// and the command palette — is a *view* over this one list, so a new capability
// shows up everywhere by adding one entry here.
//
// An action is pinnable when a click does something: it runs directly, opens a
// workspace picker, or opens one of the top-level menu flyouts. Reference entries
// are listed for discoverability but not clickable (e.g. copy/paste are terminal
// chords); they still show their shortcut so users learn them.
//
// The desktop grabs ARE clickable, but a click and the global hotkey aim
// differently: clicking the menu means Aico holds focus, so a click *picks* a
// window (`-p`) or *drags* a region (`-r`); the hotkey grabs whatever window is
// already focused (the fast path). Each grab's `note` spells this out.

// Late-bound so the `palette` action can open the palette without this module
// importing the control surface (which imports this module).
let paletteOpener: () => void = () => {}
export function setPaletteOpener(fn: () => void): void {
  paletteOpener = fn
}

export interface Action {
  id: string
  /** Group header in the menu, in first-seen order. */
  section: string
  label: string
  /** Human-readable shortcut, e.g. "Ctrl+Shift+M", or a CLI verb for references. */
  shortcut: string
  /** Single glyph shown in the cluster/menu/palette. */
  icon: string
  /** Optional accent (Lantern palette); tints the icon — used by per-TUI launchers. */
  accent?: string
  /** Optional one-line explainer shown in the hover tooltip (e.g. how a click
   * differs from the hotkey for a grab). */
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
    id: 'voice',
    section: 'Voice',
    label: 'Dictate into widget',
    shortcut: 'Ctrl+Shift+M',
    icon: '🎙',
    run: () => window.dispatchEvent(new CustomEvent('aico:voice-toggle')),
  },
  {
    id: 'indicate',
    section: 'Capture',
    label: 'Indicate selection',
    shortcut: 'Ctrl+Shift+Space',
    icon: '⊹',
    note: 'Pull the latest text/image the selection bus captured into this widget.',
    run: () => window.aico.actions.indicate(),
  },
  {
    id: 'grab-image',
    section: 'Capture',
    label: 'Grab window · package',
    shortcut: 'Super+Shift+G',
    icon: '▣',
    note: 'Click to pick a window; the hotkey packages the focused one. Bundles image + OCR text + metadata in an index the agent reads cheapest-first.',
    run: () => window.aico.actions.grab(['-p']),
  },
  {
    id: 'grab-text',
    section: 'Capture',
    label: 'Grab window · text only',
    shortcut: 'Super+Shift+T',
    icon: '⊟',
    note: 'Click to pick a window and OCR it to plain text; the hotkey OCRs the focused window. Lighter than a package when text is all you need.',
    run: () => window.aico.actions.grab(['-p', '-t']),
  },
  {
    id: 'grab-region',
    section: 'Capture',
    label: 'Grab region · package',
    shortcut: 'Super+Shift+R',
    icon: '◫',
    note: 'Click (or hotkey) to drag-select a screen region; bundles image + OCR text + metadata, with the native crop kept for legible detail.',
    run: () => window.aico.actions.grab(['-r']),
  },
  {
    // Flyout-only host (no run): hovering opens the "New widget" picker — the TUI
    // list, each TUI drilling into a workspace to launch in. A launch always
    // names both, so there's no default fast path.
    id: 'new-widget',
    section: 'Widget',
    label: 'New widget',
    shortcut: '',
    icon: '＋',
    opensFlyout: true,
  },
  {
    // Flyout-only host (no run): hovering opens the "Replace with <TUI>" picker,
    // which runs in the focused widget. No default action — replacing is
    // destructive, so the user must pick a specific TUI.
    id: 'replace-tui',
    section: 'Widget',
    label: 'Replace TUI',
    shortcut: '',
    icon: '⟳',
    opensFlyout: true,
  },
  {
    id: 'hub',
    section: 'Widget',
    label: 'Hub view',
    shortcut: 'Ctrl+Shift+H',
    icon: '⊞',
    run: () => window.aico.actions.hub(),
  },
  {
    id: 'palette',
    section: 'Widget',
    label: 'Command palette',
    shortcut: 'Ctrl+Shift+P',
    icon: '⌕',
    run: () => paletteOpener(),
  },
  {
    id: 'refresh',
    section: 'Widget',
    label: 'Refresh terminal',
    shortcut: 'Ctrl+Shift+R',
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
    section: 'Widget',
    label: 'Open workspace',
    shortcut: '',
    icon: '⇄',
    opensFlyout: true,
  },
  {
    id: 'attach-tmux',
    section: 'Widget',
    label: 'Attach tmux session',
    shortcut: '',
    icon: '⇱',
    opensFlyout: true,
  },
  {
    id: 'retire-widget',
    section: 'Widget',
    label: 'Retire widget',
    shortcut: '', // destructive (ends the tmux session) — no chord, to avoid accidents
    icon: '⏏',
    run: () => window.aico.actions.retire(),
  },
  {
    id: 'copy',
    section: 'Edit',
    label: 'Copy selection',
    shortcut: 'Ctrl+Shift+C',
    icon: '⧉',
  },
  {
    id: 'paste',
    section: 'Edit',
    label: 'Paste',
    shortcut: 'Ctrl+Shift+V',
    icon: '⎘',
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
export function setTuiActions(tuis: { slug: string; displayName: string; accent: string }[]): void {
  tuiActions = tuis.flatMap((t) => [
    {
      id: `new:${t.slug}`,
      section: 'Widget',
      label: `New ${t.displayName}`,
      shortcut: '', // launched from the flyout / a pinned icon — no chord
      icon: '＋',
      accent: t.accent,
      // No run: clicking pops the workspace picker (the menu drill-down / pinned
      // icon), which calls newWidget(slug, projectId) once a project is chosen.
      picksProject: true,
    },
    {
      id: `replace:${t.slug}`,
      section: 'Widget',
      label: `Replace with ${t.displayName}`,
      shortcut: '', // destructive (ends the current pane) — no chord
      icon: '⟳',
      accent: t.accent,
      run: () => window.aico.actions.loadTui(t.slug),
    },
  ])
}

// Per-workspace launch actions, built from the Aico workspace catalog at init
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
    section: 'Widget',
    label: `Open ${p.name}`,
    shortcut: '', // launched from the flyout / a pinned icon — no chord
    icon: '⇄',
    run: () => window.aico.actions.switchProject(p.id),
  }))
}

let tmuxSessionActions: Action[] = []

export function setTmuxSessionActions(
  sessions: { id: string; label: string; source: string }[],
): void {
  tmuxSessionActions = sessions.map((s) => ({
    id: `tmux:${s.id}`,
    section: 'Widget',
    label: `Attach ${s.label}`,
    shortcut: '',
    icon: '⇱',
    note: s.source,
    run: () => window.aico.actions.attachTmuxSession(s.id),
  }))
}

/** The static registry plus the dynamic per-TUI and per-project launchers — what
 * findAction, the palette, and the pin set resolve over (the menu uses ACTIONS). */
export function allActions(): Action[] {
  return [...ACTIONS, ...tuiActions, ...projectActions, ...tmuxSessionActions]
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
export const DEFAULT_PINS = ['voice', 'indicate']

/** Drop unknown/un-pinnable ids so the persisted set stays valid as actions change. */
export function sanitizePins(pins: string[]): string[] {
  const seen = new Set<string>()
  return pins.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    const a = findAction(id)
    return !!a && isPinnable(a)
  })
}

/** Resolve pinned ids (already sanitized) to their actions, preserving order. */
export function pinnedActions(pins: string[]): Action[] {
  return pins.map(findAction).filter((a): a is Action => !!a)
}

export function togglePin(pins: string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]
}

/** Move the pin at `from` to index `to`; returns the input unchanged if out of range. */
export function reorderPins(pins: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= pins.length || to >= pins.length) return pins
  const next = [...pins]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
