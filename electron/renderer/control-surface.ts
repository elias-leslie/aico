// Renders the three discoverability surfaces over the action registry:
//   • the lantern menu (◇)      — the canonical home; also the pin manager + cheat sheet
//   • the pinned titlebar cluster — only the actions the user pinned, drag-reorderable
//   • the command palette (Ctrl+Shift+P) — searchable list of runnable actions
// Pin state is global (one row in aico.db, via the preload `settings` bridge) and
// broadcast to every widget so all clusters stay in sync.

import {
  AICO_FONT_SIZES,
  AICO_FONTS,
  type AicoFontId,
  type AicoFontSize,
  type AicoTerminalFontSettings,
  DEFAULT_TERMINAL_FONT_SETTINGS,
  parseTerminalFontSettings,
} from '../shared/font-settings'
import type {
  CheckInMenu,
  InstructionPrompt,
  InstructionRevision,
  Listing,
  OpenableSession,
} from '../types'
import {
  ACTIONS,
  type Action,
  allActions,
  cancelCheckIn,
  checkInLater,
  DEFAULT_PINS,
  findAction,
  isPinnable,
  listGames,
  movePin,
  openExistingSession,
  pinnedActions,
  prunePins,
  runAction,
  sections,
  setPaletteOpener,
  togglePin,
} from './actions'
import { createArmGuard } from './arm-guard'
import { createCatalogState, type ProjectInfo, type TuiInfo } from './catalog-state'
import { windowChord } from './chords'
import { paletteKeyIntent, paletteMatches } from './palette'

// Filled thumbtack; color + opacity (via CSS) distinguish pinned from unpinned.
const PIN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><rect x="11" y="11" width="2" height="9" rx="1"/></svg>'

let pins: string[] = []
let glyphEl: HTMLElement
let menuEl: HTMLElement
let clusterEl: HTMLElement
let paletteEl: HTMLElement
let paletteInput: HTMLInputElement
let paletteList: HTMLElement
let paletteItems: Action[] = []
let paletteSel = 0
let terminalFontSettings = DEFAULT_TERMINAL_FONT_SETTINGS
let fontFamilySelect: HTMLSelectElement | null = null
let fontSizeSelect: HTMLSelectElement | null = null
// The flyout is shared and appended to the shell because the menu clips horizontally.
const catalogs = createCatalogState({
  listTuis: () => window.aico.actions.listTuis(),
  listProjects: () => window.aico.actions.listProjects(),
  listOpenableSessions: () => window.aico.actions.listOpenableSessions(),
})
let submenuEl: HTMLElement
let submenuKind: FlyoutKind | null = null
// The workspace picker the flyout shows, if any (populateNewProjects), with the
// instructions chosen for its next launch and which of its lists is showing.
type ChosenInstructions = { prompt: string; name: string; revision: string }
let picker: {
  slug: string
  withBack: boolean
  instructions: ChosenInstructions | null
  view: 'workspaces' | 'prompts' | InstructionPrompt
} | null = null

/** Requery Tether's sessions whenever the "Open session" flyout appears. */
export function refreshSessions(): Promise<{ status: 'ready' | 'empty' | 'unavailable' }> {
  return catalogs.refreshSessions()
}

function required<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`control surface: missing ${selector}`)
  return el
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  return el
}

function partLabel(part: string): string {
  return part === 'Shift' ? '⇧' : part === 'Space' ? 'Spc' : part
}

// Shortcut chips for a key chord ("Ctrl+Shift+Space"); a single mono token for CLI verbs.
function kbd(shortcut: string): HTMLElement {
  const wrap = make('span', 'aico-kbd')
  if (shortcut.includes('+')) {
    for (const part of shortcut.split('+')) {
      const s = make('span')
      s.textContent = partLabel(part)
      wrap.append(s)
    }
  } else {
    wrap.classList.add('cli')
    const s = make('span')
    s.textContent = shortcut
    wrap.append(s)
  }
  return wrap
}

// ---- hover tooltip (shortcut + description) --------------------------------
// One shared, Lantern-styled tooltip reused by menu rows and cluster icons, so
// the surfaces themselves stay uncluttered. Positioned within the shell.

let tipEl: HTMLElement

function showTip(target: HTMLElement, a: Action, placement: 'left' | 'below'): void {
  tipEl.innerHTML = ''
  const label = make('span', 'aico-tip-label')
  label.textContent = a.label
  tipEl.append(label)
  if (a.shortcut) tipEl.append(kbd(a.shortcut))
  if (a.note) {
    const note = make('span', 'aico-tip-note')
    note.textContent = a.note
    tipEl.append(note)
  }
  tipEl.hidden = false // unhide before measuring
  placeTip(target, placement)
}

// Position the (already-filled, unhidden) tooltip beside its target, clamped
// inside the shell. Shared by the hover tip and the "click again" arm tip.
function placeTip(target: HTMLElement, placement: 'left' | 'below'): void {
  const shell = tipEl.offsetParent as HTMLElement | null
  if (!shell) return
  const s = shell.getBoundingClientRect()
  const t = target.getBoundingClientRect()
  const w = tipEl.offsetWidth
  const h = tipEl.offsetHeight
  let left: number
  let top: number
  if (placement === 'left') {
    left = t.left - s.left - w - 8
    top = t.top - s.top + t.height / 2 - h / 2
  } else {
    left = t.left - s.left + t.width / 2 - w / 2
    top = t.bottom - s.top + 8
  }
  left = Math.max(6, Math.min(left, s.width - w - 6))
  top = Math.max(6, Math.min(top, s.height - h - 6))
  tipEl.style.left = `${left}px`
  tipEl.style.top = `${top}px`
}

// ---- destructive-action arming ("click again to confirm") ------------------
// The armed icon/row shows an "armed" pulse + a "click again" tip.
const arming = createArmGuard<HTMLElement>({
  onArm: (el) => el.classList.add('armed'),
  onDisarm: (el) => el.classList.remove('armed'),
})

// Returns true if this click only ARMED the action (caller must not run it yet);
// false means run now (either a non-guarded action or the confirming 2nd click).
function armGuard(id: string, el: HTMLElement, placement: 'left' | 'below'): boolean {
  if (!arming.guard(id, el)) return false
  const a = findAction(id)
  if (a) showArmTip(el, a, placement)
  return true
}

function showArmTip(target: HTMLElement, a: Action, placement: 'left' | 'below'): void {
  tipEl.innerHTML = ''
  const label = make('span', 'aico-tip-label')
  label.textContent = a.label
  const note = make('span', 'aico-tip-note')
  note.textContent = 'Click again to confirm'
  tipEl.append(label, note)
  tipEl.hidden = false
  placeTip(target, placement)
}

function hideTip(): void {
  if (tipEl) tipEl.hidden = true
}

function attachTip(el: HTMLElement, a: Action, placement: 'left' | 'below'): void {
  el.addEventListener('mouseenter', () => showTip(el, a, placement))
  el.addEventListener('mouseleave', hideTip)
  el.addEventListener('mousedown', hideTip) // dismiss as the action fires
}

// ---- lantern menu ----------------------------------------------------------

function pinButton(id: string): HTMLButtonElement {
  const b = make('button', 'aico-pin')
  b.type = 'button'
  b.dataset.pinId = id // so pin state syncs across the menu and the flyout
  b.innerHTML = PIN_SVG
  b.addEventListener('click', (e) => {
    e.stopPropagation() // pinning must not also run the row's action
    commitPins(togglePin(pins, id))
  })
  return b
}

// Fill an icon slot: a per-TUI launcher shows its tool's mark (a Restart one
// with a small ⟳ badge), anything else its glyph. The SVG is static,
// developer-authored markup from the TUI spec, never user input.
function setActionIcon(el: HTMLElement, a: Action): void {
  if (!a.svg) {
    el.textContent = a.icon
    return
  }
  el.textContent = ''
  el.append(tuiMark(a.svg, a.accent ?? ''))
  if (a.id.startsWith('replace:')) {
    const badge = make('span', 'aico-mark-badge')
    badge.textContent = '⟳'
    el.append(badge)
  }
}

function tuiMark(svg: string, accent: string): HTMLElement {
  const mark = make('span', 'aico-mark')
  mark.innerHTML = svg
  mark.style.color = accent
  return mark
}

function menuRow(a: Action): HTMLElement {
  const row = make('div', 'aico-row')
  row.dataset.id = a.id
  const flyoutKind = FLYOUTS[a.id]

  const ic = make('span', 'aico-ic')
  setActionIcon(ic, a)
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = a.label
  // Shortcut + note live in the hover tooltip, not inline — keeps the menu uncluttered.
  row.append(ic, lbl)

  if (isPinnable(a)) {
    row.classList.add('runnable')
    row.append(pinButton(a.id))
    row.addEventListener('click', () => {
      if (flyoutKind) {
        showSubmenu(row, flyoutKind)
        return
      }
      if (armGuard(a.id, row, 'left')) return // first click on a guarded row (retire): arm only
      closeMenu()
      runAction(a.id)
    })
    row.addEventListener('mouseleave', () => {
      arming.release(row)
    })
  }

  // Rows that own a picker flyout: "New session" (kind 'new', new widgets),
  // "Restart with another tool" (kind 'replace', the focused widget), "Restart
  // in project" (kind 'project', rebinds the focused widget), "Open session"
  // (kind 'sessions') and "Choose game" (kind 'game'). Hovering or clicking
  // opens the choices; the flyout replaces the left tooltip for these rows.
  if (flyoutKind) {
    row.classList.add('has-flyout')
    const caret = make('span', 'aico-caret')
    caret.textContent = '▸'
    row.append(caret)
    row.addEventListener('mouseenter', () => showSubmenu(row, flyoutKind))
    row.addEventListener('mouseleave', (e) => {
      if (!submenuEl.contains(e.relatedTarget as Node | null)) hideSubmenu()
    })
  } else {
    attachTip(row, a, 'left')
  }
  return row
}

// The flyout-bearing menu rows and the launcher action-id prefix each uses
// (`<kind>:<slug>` for TUIs, `project:<id>` for workspaces).
type FlyoutKind = 'new' | 'replace' | 'project' | 'sessions' | 'game' | 'checkin'
const FLYOUTS: Partial<Record<string, FlyoutKind>> = {
  'arcade-pick': 'game',
  'new-widget': 'new',
  'replace-tui': 'replace',
  'switch-project': 'project',
  'attach-tmux': 'sessions', // the id predates Tether; kept so existing pins resolve
  'check-in-later': 'checkin',
}

// One flyout row: the launcher id, the bare display label (the fuller action
// label shows in the palette + pin tip), a pin button, and a `decorate` hook for
// the leading dot. Click arms-then-runs guarded launchers, else runs immediately.
function submenuRow(id: string, label: string, decorate: (dot: HTMLElement) => void): HTMLElement {
  const item = make('div', 'aico-sub-row runnable')
  item.dataset.id = id
  const dot = make('span', 'aico-sub-dot')
  decorate(dot)
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = label
  item.append(dot, lbl, pinButton(id))
  item.addEventListener('click', () => {
    if (armGuard(id, item, 'left')) return // first click on a guarded launcher: arm only
    closeMenu()
    runAction(id)
  })
  item.addEventListener('mouseleave', () => {
    arming.release(item)
  })
  return item
}

// A "New <TUI>" row in the New-widget flyout: pinnable (the launcher pins to the
// cluster), but a HOST, not a runner — a launch must name a workspace, so clicking
// drills the shared flyout into that TUI's workspace picker rather than launching.
function newTuiRow(t: TuiInfo): HTMLElement {
  const id = `new:${t.slug}`
  const item = make('div', 'aico-sub-row runnable has-flyout')
  item.dataset.id = id
  const dot = tuiMark(t.icon, t.accent)
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = t.displayName
  const caret = make('span', 'aico-caret')
  caret.textContent = '▸'
  item.append(dot, lbl, pinButton(id), caret)
  // Drill in place (the panel is already shown + positioned); the pin button
  // stops propagation, so pinning never drills. stopPropagation is essential:
  // repopulating wipes this row from submenuEl, so a bubbled click would fail the
  // click-outside handler's `submenuEl.contains(target)` test (the row is gone)
  // and wrongly close the whole menu.
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    populateNewProjects(t.slug, true)
    replaceSubmenu() // the workspace list is longer than the TUI list
  })
  return item
}

// A workspace row inside a "New <TUI>" picker: opens a new widget bound to that
// workspace. Launch-only — creating a widget isn't destructive (no arm guard),
// and it isn't independently pinnable (pinning is at the TUI level).
function newProjectRow(slug: string, p: ProjectInfo): HTMLElement {
  const item = make('div', 'aico-sub-row runnable')
  const dot = make('span', 'aico-sub-dot project') // neutral ring; .current fills it
  dot.classList.toggle('current', p.current)
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = p.name
  item.append(dot, lbl)
  item.addEventListener('click', () => {
    const chosen = picker?.instructions
    closeMenu() // tidies up in both the drilled-menu and standalone-popup cases
    window.aico.actions.newWidget(
      slug,
      p.id,
      chosen ? { prompt: chosen.prompt, revision: chosen.revision } : undefined,
    )
  })
  return item
}

// Fill the shared flyout with the workspace picker for `slug` (the second level of
// "New widget"). `withBack` adds a row back to the TUI list — present in the menu
// drill-down, absent in the standalone popup (pinned icon / palette), which has
// nothing to go back to.
function populateNewProjects(slug: string, withBack: boolean): void {
  // A choice made for this tool stays while its picker is open.
  const instructions = picker?.slug === slug ? picker.instructions : null
  picker = { slug, withBack, instructions, view: 'workspaces' }
  submenuEl.innerHTML = ''
  if (withBack) {
    const back = make('div', 'aico-sub-row aico-sub-back runnable')
    const lbl = make('span', 'aico-lbl')
    lbl.textContent = '‹ New session'
    back.append(lbl)
    back.addEventListener('click', (e) => {
      e.stopPropagation() // same as newTuiRow: repopulating wipes this row, so don't let the bubble close the menu
      populateSubmenu('new')
      replaceSubmenu()
    })
    submenuEl.append(back)
  }
  const tool = catalogs.tuis.find((t) => t.slug === slug)
  if (tool?.instructions) submenuEl.append(instructionsRow(instructions))
  if (tool?.blankSlate) {
    // The main process's BLANK_SLATE_ID: a new empty workspace, not a project.
    submenuEl.append(
      newProjectRow(slug, { id: '__aico_blank_slate__', name: 'Blank Slate', current: false }),
    )
  }
  if (catalogs.projects.length) {
    for (const p of catalogs.projects) submenuEl.append(newProjectRow(slug, p))
  } else {
    const empty = make('div', 'aico-sub-row empty')
    empty.textContent = 'No projects'
    submenuEl.append(empty)
  }
}

// ---- chosen instructions ----------------------------------------------------
// The workspace picker's top row picks an Agent Hub prompt revision for the
// next launch (docs/root-control.md "Chosen instructions"): prompts, then that
// prompt's revisions, then back to the workspaces with the choice shown.
// Rows here redraw the flyout, so their clicks stop propagation (newTuiRow).

function drillRow(label: string, onClick: () => void, cls = ''): HTMLElement {
  const item = make('div', `aico-sub-row runnable ${cls}`.trim())
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = label
  item.append(lbl)
  item.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return item
}

function backToWorkspaces(): void {
  if (!picker) return
  populateNewProjects(picker.slug, picker.withBack)
  replaceSubmenu()
}

function instructionsRow(chosen: ChosenInstructions | null): HTMLElement {
  const item = drillRow('Instructions', () => showInstructionPrompts(), 'aico-sub-instructions')
  const dot = make('span', 'aico-sub-dot project')
  dot.classList.toggle('current', chosen !== null)
  const value = make('span', 'aico-sub-time aico-sub-note aico-sub-value')
  value.textContent = chosen ? `${chosen.name} · ${chosen.revision.slice(0, 8)}` : 'None'
  item.title = chosen
    ? `${chosen.prompt}@${chosen.revision.slice(0, 8)}, added to the agent's instructions`
    : "Add an Agent Hub prompt to the agent's instructions"
  const caret = make('span', 'aico-caret')
  caret.textContent = '▸'
  item.prepend(dot)
  item.append(value, caret)
  return item
}

// The prompt list is read each time it opens; a newer read wins.
let promptListing: Listing<InstructionPrompt> | null = null
let promptRead = 0
let promptFilter = ''

function showInstructionPrompts(): void {
  if (!picker) return
  picker.view = 'prompts'
  promptListing = null
  promptFilter = ''
  const read = ++promptRead
  renderInstructionPrompts()
  void window.aico.actions
    .instructionPrompts()
    .catch((): Listing<InstructionPrompt> => ({ status: 'unavailable', items: [] }))
    .then((listing) => {
      if (read !== promptRead) return
      promptListing = listing
      if (!submenuEl.hidden && picker?.view === 'prompts') renderPromptRows()
    })
}

function renderInstructionPrompts(): void {
  submenuEl.innerHTML = ''
  submenuEl.append(drillRow('‹ Workspaces', backToWorkspaces, 'aico-sub-back'))
  const filter = make('input', 'aico-sub-filter')
  filter.type = 'text'
  filter.placeholder = 'Filter prompts'
  filter.setAttribute('aria-label', 'Filter prompts')
  filter.value = promptFilter
  filter.addEventListener('input', () => {
    promptFilter = filter.value
    renderPromptRows()
  })
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const first = filteredPrompts()[0]
    if (first) showInstructionRevisions(first)
  })
  submenuEl.append(filter, make('div', 'aico-sub-list'))
  renderPromptRows()
  replaceSubmenu()
  filter.focus()
}

function filteredPrompts(): InstructionPrompt[] {
  const needle = promptFilter.trim().toLowerCase()
  return (promptListing?.items ?? []).filter(
    (p) =>
      !needle ||
      p.name.toLowerCase().includes(needle) ||
      p.slug.toLowerCase().includes(needle) ||
      p.description.toLowerCase().includes(needle),
  )
}

function renderPromptRows(): void {
  const list = submenuEl.querySelector<HTMLElement>('.aico-sub-list')
  if (!list || !picker) return
  list.innerHTML = ''
  if (picker.instructions)
    list.append(
      drillRow('None', () => {
        if (picker) picker.instructions = null
        backToWorkspaces()
      }),
    )
  if (!promptListing) {
    list.append(emptySubmenuRow('Loading prompts…'))
    return
  }
  if (promptListing.status === 'unavailable') {
    list.append(emptySubmenuRow("Couldn't load prompts from Agent Hub"))
    return
  }
  const prompts = filteredPrompts()
  if (!prompts.length) {
    list.append(emptySubmenuRow(promptListing.items.length ? 'No prompts match' : 'No prompts'))
    return
  }
  for (const p of prompts) {
    const row = drillRow(p.name, () => showInstructionRevisions(p), 'has-flyout')
    row.title = p.description ? `${p.slug}: ${p.description}` : p.slug
    const caret = make('span', 'aico-caret')
    caret.textContent = '▸'
    row.append(caret)
    list.append(row)
  }
}

let revisionRead = 0

function showInstructionRevisions(prompt: InstructionPrompt): void {
  if (!picker) return
  picker.view = prompt
  const read = ++revisionRead
  const render = (listing: Listing<InstructionRevision> | null): void => {
    submenuEl.innerHTML = ''
    submenuEl.append(drillRow(`‹ ${prompt.name}`, showInstructionPromptsAgain, 'aico-sub-back'))
    if (!listing) submenuEl.append(emptySubmenuRow('Loading revisions…'))
    else if (listing.status === 'unavailable')
      submenuEl.append(emptySubmenuRow("Couldn't load revisions from Agent Hub"))
    else if (!listing.items.length) submenuEl.append(emptySubmenuRow('No saved revisions'))
    else for (const r of listing.items) submenuEl.append(revisionRow(prompt, r))
    replaceSubmenu()
  }
  render(null)
  void window.aico.actions
    .instructionRevisions(prompt.slug)
    .catch((): Listing<InstructionRevision> => ({ status: 'unavailable', items: [] }))
    .then((listing) => {
      if (read === revisionRead && !submenuEl.hidden && picker?.view === prompt) render(listing)
    })
}

// Back from revisions keeps the filter and the list already read.
function showInstructionPromptsAgain(): void {
  if (!picker) return
  picker.view = 'prompts'
  if (!promptListing) showInstructionPrompts()
  else renderInstructionPrompts()
}

function revisionDate(iso: string | null): string {
  const date = iso ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Undated'
}

function revisionRow(prompt: InstructionPrompt, r: InstructionRevision): HTMLElement {
  const short = r.id.slice(0, 8)
  const label = `${revisionDate(r.createdAt)} · ${short}`
  const tag = make('span', 'aico-sub-time aico-sub-note')
  tag.textContent = r.usable ? (r.current ? 'current' : '') : "can't be used"
  if (!r.usable) {
    const row = make('div', 'aico-sub-row empty')
    const lbl = make('span', 'aico-lbl')
    lbl.textContent = label
    row.title = 'Empty, over 64 KiB, or holds text the tools can’t take'
    row.append(lbl, tag)
    return row
  }
  const row = drillRow(label, () => {
    if (!picker) return
    picker.instructions = { prompt: prompt.slug, name: prompt.name, revision: r.id }
    backToWorkspaces()
  })
  row.classList.toggle('current', r.current)
  if (r.reason) row.title = r.reason
  row.append(tag)
  return row
}

// A row in the "Open session" flyout: opens that Tether session in a window.
// Sessions come and go, so a row is neither an action nor pinnable; pin "Open
// session" itself instead. Opening is not destructive (no arm guard).
function sessionRow(session: OpenableSession): HTMLElement {
  const item = make('div', 'aico-sub-row runnable')
  const dot = make('span', 'aico-sub-dot project')
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = sessionSubmenuLabel(session)
  item.append(dot, lbl)
  item.addEventListener('click', () => {
    closeMenu()
    void openExistingSession(session.id)
  })
  return item
}

// "Check in later": read fresh each time the flyout opens, since the times
// move with the clock and the pending list changes from elsewhere.
let checkIns: CheckInMenu | null = null

function refreshCheckIns(): Promise<void> {
  return window.aico.actions
    .checkInMenu()
    .then((menu) => {
      checkIns = menu
    })
    .catch(() => {
      checkIns = { status: 'unavailable', choices: [], pending: [] }
    })
}

// A check-in row runs at once: setting one is not destructive, and a pending
// one says what Cancel removes. Neither is pinnable (times change).
function checkInRow(label: string, time: string, run: () => void): HTMLElement {
  const item = make('div', 'aico-sub-row runnable')
  const dot = make('span', 'aico-sub-dot project')
  const lbl = make('span', 'aico-lbl')
  lbl.textContent = label
  const when = make('span', 'aico-sub-time')
  when.textContent = time
  item.append(dot, lbl, when)
  item.addEventListener('click', () => {
    closeMenu()
    run()
  })
  return item
}

function populateCheckIns(): void {
  if (!checkIns) {
    submenuEl.append(emptySubmenuRow('Loading…'))
    return
  }
  if (checkIns.status === 'ready')
    for (const choice of checkIns.choices)
      submenuEl.append(checkInRow(choice.label, choice.time, () => void checkInLater(choice.dueAt)))
  else
    submenuEl.append(
      emptySubmenuRow(
        checkIns.status === 'unsupported'
          ? 'Only Claude Code and Codex sessions take check-ins'
          : 'Check-ins unavailable',
      ),
    )
  for (const wake of checkIns.pending)
    submenuEl.append(
      checkInRow('Cancel check-in', wake.time, () => void cancelCheckIn(wake.id, wake.time)),
    )
}

function emptySubmenuRow(label: string): HTMLElement {
  const empty = make('div', 'aico-sub-row empty')
  empty.textContent = label
  return empty
}

export function sessionSubmenuLabel(
  session: Pick<OpenableSession, 'label' | 'project'> & { tool?: string | null },
): string {
  const project = session.project?.trim()
  const parts = [session.label]
  if (project && project !== session.label) parts.push(project)
  const tool = session.tool?.trim()
  if (
    tool &&
    tool.toLowerCase() !== 'shell' &&
    !parts.some((part) => part.toLowerCase() === tool.toLowerCase())
  ) {
    parts.push(`${tool[0].toUpperCase()}${tool.slice(1)}`)
  }
  return parts.join(' · ')
}

// Fill the shared flyout for `kind`. 'new': TUI rows that drill into a workspace
// picker. 'replace': TUI rows that replace the focused pane (launcher
// `replace:<slug>`). 'project': workspace rows that rebind the focused widget
// (`project:<id>`). 'replace'/'project' rows carry a pin button.
function populateSubmenu(kind: FlyoutKind): void {
  submenuKind = kind
  picker = null
  submenuEl.innerHTML = ''
  if (kind === 'new') {
    if (catalogs.tuis.length) {
      for (const t of catalogs.tuis) submenuEl.append(newTuiRow(t))
    } else {
      submenuEl.append(emptySubmenuRow('No TUIs'))
    }
  } else if (kind === 'project') {
    if (catalogs.projects.length) {
      for (const p of catalogs.projects) {
        submenuEl.append(
          submenuRow(`project:${p.id}`, p.name, (dot) => {
            dot.classList.add('project') // neutral ring; .current fills it (see CSS)
            dot.classList.toggle('current', p.current)
          }),
        )
      }
    } else {
      submenuEl.append(emptySubmenuRow('No projects'))
    }
  } else if (kind === 'game') {
    const current = document.querySelector<HTMLElement>('.titlebar')?.dataset.arcade
    for (const g of listGames()) {
      submenuEl.append(
        submenuRow(`game:${g.key}`, g.name, (dot) => {
          dot.classList.add('project') // neutral ring; .current fills it (see CSS)
          dot.classList.toggle('current', g.key === current)
        }),
      )
    }
  } else if (kind === 'checkin') {
    populateCheckIns()
  } else if (kind === 'sessions') {
    if (catalogs.sessions.length) {
      for (const session of catalogs.sessions) submenuEl.append(sessionRow(session))
    } else {
      submenuEl.append(
        emptySubmenuRow(
          catalogs.sessionStatus === 'unavailable' ? 'Sessions unavailable' : 'No sessions to open',
        ),
      )
    }
  } else {
    if (catalogs.tuis.length) {
      for (const t of catalogs.tuis) {
        submenuEl.append(
          submenuRow(`replace:${t.slug}`, t.displayName, (dot) => {
            dot.className = 'aico-mark'
            dot.innerHTML = t.icon // static SVG from the TUI spec
            dot.style.color = t.accent
          }),
        )
      }
    } else {
      submenuEl.append(emptySubmenuRow('No TUIs'))
    }
  }
  syncMenuPinStates() // reflect pinned state on the freshly built pin buttons
}

// True while the flyout is shown on its own (from a pinned icon / palette), not
// as part of the open lantern menu — so the right dismissal path applies.
let submenuStandalone = false

// Position the flyout against `anchor`, clamped inside the shell. 'left' hugs the
// row (the menu sits at the right edge), with a 2px overlap that kills the hover
// dead-zone; 'below' centers under a titlebar control (pinned icon / glyph).
// A list taller than the shell scrolls inside the flyout instead of running off
// its bottom edge.
let lastPlacement: { anchor: HTMLElement; placement: 'left' | 'below' } | null = null
function placeSubmenu(anchor: HTMLElement, placement: 'left' | 'below'): void {
  lastPlacement = { anchor, placement }
  const shell = submenuEl.offsetParent as HTMLElement | null
  if (!shell) return
  const s = shell.getBoundingClientRect()
  submenuEl.style.maxHeight = `${Math.max(0, s.height - 12)}px`
  const r = anchor.getBoundingClientRect()
  const w = submenuEl.offsetWidth
  const h = submenuEl.offsetHeight
  let left = placement === 'left' ? r.left - s.left - w + 2 : r.left - s.left + r.width / 2 - w / 2
  let top = placement === 'left' ? r.top - s.top - 6 : r.bottom - s.top + 8
  left = Math.max(6, Math.min(left, s.width - w - 6))
  top = Math.max(6, Math.min(top, s.height - h - 6))
  submenuEl.style.left = `${left}px`
  submenuEl.style.top = `${top}px`
}

// Re-fit the flyout after its contents changed in place (a drill-down).
function replaceSubmenu(): void {
  if (lastPlacement) placeSubmenu(lastPlacement.anchor, lastPlacement.placement)
  submenuEl.scrollTop = 0
}

// Requery the tools behind a tool list or workspace picker, then redraw it if it
// is still showing, so a window loaded before a Tether update still offers
// what the tools now support.
function refreshTuisThen(): void {
  void catalogs.refreshTuis().then(() => {
    if (submenuEl.hidden) return
    if (picker?.view === 'workspaces') populateNewProjects(picker.slug, picker.withBack)
    else if (picker) return
    else if (submenuKind === 'new' || submenuKind === 'replace') populateSubmenu(submenuKind)
    else return
    replaceSubmenu()
  })
}

function refreshCheckInsThen(anchor: HTMLElement, place: 'left' | 'below'): void {
  void refreshCheckIns().then(() => {
    if (submenuEl.hidden || submenuKind !== 'checkin') return
    populateSubmenu('checkin')
    placeSubmenu(anchor, place)
  })
}

// Open a `kind` flyout from its menu row (part of the lantern menu).
function showSubmenu(row: HTMLElement, kind: FlyoutKind): void {
  submenuStandalone = false
  populateSubmenu(kind)
  submenuEl.hidden = false // unhide before measuring
  placeSubmenu(row, 'left')
  if (kind === 'new' || kind === 'replace') refreshTuisThen()
  if (kind === 'checkin') refreshCheckInsThen(row, 'left')
  if (kind === 'sessions') {
    void refreshSessions().then(() => {
      if (submenuEl.hidden || submenuKind !== kind) return
      populateSubmenu(kind)
      placeSubmenu(row, 'left')
    })
  }
}

// Pop any top-level flyout on its own (a pinned titlebar dropdown or a palette
// pick), anchored to `anchor`; dismissed by Esc / outside click via the standalone
// path.
function showStandaloneSubmenu(
  kind: FlyoutKind,
  anchor: HTMLElement,
  place: 'left' | 'below',
): void {
  hideTip()
  populateSubmenu(kind)
  submenuEl.hidden = false
  submenuStandalone = true
  placeSubmenu(anchor, place)
  if (kind === 'new' || kind === 'replace') refreshTuisThen()
  if (kind === 'checkin') refreshCheckInsThen(anchor, place)
  if (kind === 'sessions') {
    void refreshSessions().then(() => {
      if (submenuEl.hidden || submenuKind !== kind) return
      populateSubmenu(kind)
      placeSubmenu(anchor, place)
    })
  }
}

// Pop the workspace picker for `slug` on its own (a pinned "New <TUI>" icon or a
// palette pick), anchored to `anchor`. No back row; dismissed by Esc / outside
// click via the standalone path.
function showProjectPicker(slug: string, anchor: HTMLElement, place: 'left' | 'below'): void {
  hideTip()
  populateNewProjects(slug, false)
  submenuEl.hidden = false
  submenuStandalone = true
  placeSubmenu(anchor, place)
  refreshTuisThen()
}

function hideSubmenu(): void {
  if (submenuEl) submenuEl.hidden = true
  submenuKind = null
  picker = null
  submenuStandalone = false
}

function buildMenu(): void {
  menuEl.innerHTML = ''
  const head = make('div', 'aico-menu-head')
  const title = make('span')
  title.textContent = 'Aico'
  const hint = make('span', 'aico-menu-hint')
  hint.textContent = 'click ⊙ to pin'
  head.append(title, hint)
  menuEl.append(head)

  for (const section of sections()) {
    const sec = make('div', 'aico-sec')
    sec.textContent = section
    menuEl.append(sec)
    for (const a of ACTIONS.filter((x) => x.section === section)) menuEl.append(menuRow(a))
  }
  buildTerminalSettings()
}

function settingSelect<T extends string | number>(
  labelText: string,
  value: T,
  options: readonly { value: T; label: string }[],
  onChange: (value: T) => void,
): HTMLSelectElement {
  const row = make('label', 'aico-setting-row')
  const label = make('span', 'aico-setting-label')
  label.textContent = labelText
  const select = make('select', 'aico-setting-select')
  for (const option of options) {
    const item = document.createElement('option')
    item.value = String(option.value)
    item.textContent = option.label
    select.append(item)
  }
  select.value = String(value)
  select.addEventListener('change', () => {
    const selected = options.find((option) => String(option.value) === select.value)
    if (selected) onChange(selected.value)
  })
  row.append(label, select)
  menuEl.append(row)
  return select
}

function updateTerminalFontSettings(patch: Partial<AicoTerminalFontSettings>): void {
  terminalFontSettings = parseTerminalFontSettings({ ...terminalFontSettings, ...patch })
  syncTerminalFontControls()
  window.aico.settings.setTerminalFont(terminalFontSettings)
}

function buildTerminalSettings(): void {
  const sec = make('div', 'aico-sec')
  sec.textContent = 'Terminal'
  menuEl.append(sec)

  fontFamilySelect = settingSelect<AicoFontId>(
    'Font Family',
    terminalFontSettings.fontId,
    AICO_FONTS.map((font) => ({ value: font.id, label: font.name })),
    (fontId) => updateTerminalFontSettings({ fontId }),
  )

  fontSizeSelect = settingSelect<AicoFontSize>(
    'Font Size',
    terminalFontSettings.fontSize,
    AICO_FONT_SIZES.map((size) => ({ value: size, label: `${size}px` })),
    (fontSize) => updateTerminalFontSettings({ fontSize }),
  )
}

function syncTerminalFontControls(): void {
  if (fontFamilySelect) fontFamilySelect.value = terminalFontSettings.fontId
  if (fontSizeSelect) fontSizeSelect.value = String(terminalFontSettings.fontSize)
}

function syncMenuPinStates(): void {
  // Covers pin buttons in both the lantern menu and the New-widget flyout.
  for (const b of document.querySelectorAll<HTMLElement>('.aico-pin')) {
    const id = b.dataset.pinId
    if (!id) continue
    const pinned = pins.includes(id)
    b.classList.toggle('is-pinned', pinned)
    b.title = pinned ? 'Pinned — click to unpin' : 'Pin to titlebar'
  }
}

function menuOpen(): boolean {
  return !menuEl.hidden
}
function openMenu(): void {
  hideSubmenu()
  syncMenuPinStates()
  menuEl.hidden = false
  glyphEl.classList.add('active')
}
function closeMenu(): void {
  menuEl.hidden = true
  glyphEl.classList.remove('active')
  hideTip()
  hideSubmenu()
  arming.disarm()
}
function toggleMenu(): void {
  if (menuOpen()) closeMenu()
  else openMenu()
}

// ---- pinned cluster --------------------------------------------------------

function clusterIcon(a: Action): HTMLElement {
  const b = make('button', 'aico-pin-icon')
  b.type = 'button'
  setActionIcon(b, a)
  b.setAttribute('aria-label', a.label)
  b.dataset.actionId = a.id
  if (a.accent) b.style.color = a.accent // per-TUI launchers read as their accent
  b.draggable = true
  attachTip(b, a, 'below') // styled tooltip instead of the native title
  b.addEventListener('focus', () => showTip(b, a, 'below'))
  b.addEventListener('blur', () => {
    hideTip()
    arming.release(b)
  })
  const flyoutKind = FLYOUTS[a.id]
  b.addEventListener('click', () => {
    if (flyoutKind) {
      closeMenu()
      showStandaloneSubmenu(flyoutKind, b, 'below')
      return
    }
    if (a.picksProject) {
      closeMenu()
      showProjectPicker(a.id.slice('new:'.length), b, 'below') // pop the workspace menu under the icon
      return
    }
    hideSubmenu()
    if (armGuard(a.id, b, 'below')) return // first click on a replace icon: arm only
    runAction(a.id)
  })
  b.addEventListener('mouseleave', () => {
    arming.release(b)
  })
  b.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/plain', a.id)
    b.classList.add('dragging')
  })
  b.addEventListener('dragend', () => b.classList.remove('dragging'))
  b.addEventListener('dragover', (e) => e.preventDefault())
  b.addEventListener('drop', (e) => {
    e.preventDefault()
    const from = e.dataTransfer?.getData('text/plain')
    if (from) commitPins(movePin(pins, from, a.id))
  })
  return b
}

function renderCluster(): void {
  clusterEl.innerHTML = ''
  for (const a of pinnedActions(pins)) clusterEl.append(clusterIcon(a))
}

// ---- command palette -------------------------------------------------------

function setPaletteSel(i: number): void {
  paletteSel = i
  ;[...paletteList.children].forEach((c, idx) => {
    c.classList.toggle('sel', idx === i)
  })
}

function renderPaletteList(): void {
  paletteItems = paletteMatches(allActions().filter(isPinnable), paletteInput.value)
  paletteList.innerHTML = ''
  paletteItems.forEach((a, i) => {
    const row = make('div', 'aico-palette-item')
    if (i === 0) row.classList.add('sel')
    const ic = make('span', 'aico-ic')
    setActionIcon(ic, a)
    const lbl = make('span', 'aico-lbl')
    lbl.textContent = a.label
    row.append(ic, lbl)
    if (a.shortcut) row.append(kbd(a.shortcut)) // per-TUI / retire have no chord
    row.addEventListener('click', () => {
      if (armGuard(a.id, row, 'below')) return // first click on "Replace with …": arm only
      paletteActivate(a)
    })
    row.addEventListener('mousemove', () => setPaletteSel(i))
    paletteList.append(row)
  })
  paletteSel = 0
}

function onPaletteKey(e: KeyboardEvent): void {
  const intent = paletteKeyIntent(e.key, paletteSel, paletteItems.length)
  if (!intent) return
  e.preventDefault()
  if (intent.kind === 'select') {
    setPaletteSel(intent.index)
  } else if (intent.kind === 'activate') {
    const a = paletteItems[paletteSel]
    if (!a) return
    const row = paletteList.children[paletteSel] as HTMLElement | undefined
    // Mirror the click path (see renderPaletteList): first Enter on a guarded
    // action (replace:/project:/retire-widget) only arms it; a second Enter
    // confirms. Without this the keyboard path destroys a running session on a
    // single keystroke.
    if (row && armGuard(a.id, row, 'below')) return
    paletteActivate(a)
  } else {
    closePalette()
  }
}

// Activate a palette item: a workspace-picking launcher ("New <TUI>") pops its
// workspace menu under the lantern glyph instead of running; everything else runs.
function paletteActivate(a: Action): void {
  closePalette()
  const flyoutKind = FLYOUTS[a.id]
  if (flyoutKind) showStandaloneSubmenu(flyoutKind, glyphEl, 'below')
  else if (a.picksProject) showProjectPicker(a.id.slice('new:'.length), glyphEl, 'below')
  else runAction(a.id)
}

function buildPalette(): void {
  paletteEl.innerHTML = ''
  const box = make('div', 'aico-palette-box')
  const top = make('div', 'aico-palette-input')
  const mag = make('span', 'aico-palette-mag')
  mag.textContent = '⌕'
  paletteInput = make('input', 'aico-palette-text')
  paletteInput.type = 'text'
  paletteInput.placeholder = 'Type a command…'
  top.append(mag, paletteInput)
  paletteList = make('div', 'aico-palette-list')
  box.append(top, paletteList)
  paletteEl.append(box)

  paletteInput.addEventListener('input', renderPaletteList)
  paletteInput.addEventListener('keydown', onPaletteKey)
  // Click on the backdrop (not the box) dismisses.
  paletteEl.addEventListener('click', (e) => {
    if (e.target === paletteEl) closePalette()
  })
}

function paletteShowing(): boolean {
  return !paletteEl.hidden
}
function openPalette(): void {
  closeMenu()
  hideTip()
  paletteInput.value = ''
  renderPaletteList()
  paletteEl.hidden = false
  paletteInput.focus()
}
function closePalette(): void {
  if (paletteEl.hidden) return
  paletteEl.hidden = true
  arming.disarm()
  window.dispatchEvent(new CustomEvent('aico:refocus')) // hand focus back to the terminal
}

// ---- shared pin commit -----------------------------------------------------

function commitPins(next: string[]): void {
  pins = prunePins(next)
  window.aico.settings.setPins(pins) // persists + broadcasts to all widgets
  renderCluster()
  syncMenuPinStates()
}

// Loading keeps the stored list as saved. Rendering skips pins whose feature is
// unavailable (pinnedActions); a pin, unpin or drag writes it back without the
// ids that can never return (prunePins).
async function loadPins(): Promise<string[]> {
  const stored = await window.aico.settings.getPins()
  if (stored != null) return stored
  window.aico.settings.setPins(DEFAULT_PINS) // first run
  return DEFAULT_PINS
}

async function loadTerminalFontSettings(): Promise<AicoTerminalFontSettings> {
  try {
    return parseTerminalFontSettings(await window.aico.settings.getTerminalFont())
  } catch {
    return DEFAULT_TERMINAL_FONT_SETTINGS
  }
}

// ---- public API ------------------------------------------------------------

/** Handle an Aico chrome chord from the terminal key handler. Returns true if
 * it consumed the event (so the caller swallows it from the PTY). */
export function controlSurfaceChord(e: KeyboardEvent): boolean {
  switch (windowChord(e)) {
    case 'palette':
      openPalette()
      return true
    case 'hub':
      runAction('hub')
      return true
    case 'refresh':
      runAction('refresh')
      return true
    default:
      return false // copy and paste belong to the terminal (renderer.ts)
  }
}

export async function initControlSurface(): Promise<void> {
  glyphEl = required('#lantern-menu-btn')
  clusterEl = required('#pinned')
  menuEl = required('#aico-menu')
  paletteEl = required('#aico-palette')

  // Shared hover tooltip, positioned within the shell (a positioned ancestor).
  tipEl = make('div', 'aico-tip')
  tipEl.hidden = true
  required('.shell').append(tipEl)

  // Independent catalogs load together, so their pinned launchers show on the
  // first render.
  await catalogs.loadInitial()
  submenuEl = make('div', 'aico-submenu')
  submenuEl.hidden = true
  submenuEl.addEventListener('mouseleave', (e) => {
    if (!menuEl.contains(e.relatedTarget as Node | null)) hideSubmenu()
  })
  required('.shell').append(submenuEl)

  pins = await loadPins()
  terminalFontSettings = await loadTerminalFontSettings()
  buildMenu()
  renderCluster()
  buildPalette()
  setPaletteOpener(openPalette)

  // Chrome chords + Escape-dismiss at the document level in the CAPTURE phase, so
  // they fire whenever the widget is focused — not only when the xterm textarea
  // holds DOM focus — and beat xterm, which calls stopPropagation() on keydown
  // (a bubble-phase listener would never see these while the terminal is focused).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        if (paletteShowing()) {
          e.preventDefault()
          e.stopPropagation()
          closePalette()
        } else if (submenuStandalone) {
          e.preventDefault()
          e.stopPropagation()
          hideSubmenu() // a pinned-icon / palette workspace picker, shown on its own
        } else if (menuOpen()) {
          e.preventDefault()
          e.stopPropagation()
          closeMenu()
        }
        return // nothing open: let the terminal/TUI use Escape normally
      }
      if (controlSurfaceChord(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    true,
  )

  glyphEl.addEventListener('click', toggleMenu)
  // Click-outside closes the menu (the glyph toggles it, so ignore clicks on it).
  // The TUI-picker flyout lives outside menuEl (appended to .shell), so it must be
  // excluded too — otherwise a click in the flyout closes the menu, which disarms
  // the replace it just armed, making the confirming second click impossible.
  document.addEventListener('click', (e) => {
    const t = e.target as Node
    if (menuOpen()) {
      if (!menuEl.contains(t) && !glyphEl.contains(t) && !submenuEl.contains(t)) closeMenu()
    } else if (submenuStandalone) {
      // Standalone workspace picker (pinned "New <TUI>" icon / palette): dismiss on
      // any click outside it, the pin cluster (its launch icons), or the glyph.
      if (!submenuEl.contains(t) && !clusterEl.contains(t) && !glyphEl.contains(t)) hideSubmenu()
    }
  })

  window.aico.settings.onPinsChanged((ids) => {
    pins = ids
    renderCluster()
    syncMenuPinStates()
  })

  window.aico.settings.onTerminalFontChanged((settings) => {
    terminalFontSettings = parseTerminalFontSettings(settings)
    syncTerminalFontControls()
  })
}
