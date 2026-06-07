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
import {
  ACTIONS,
  type Action,
  allActions,
  DEFAULT_PINS,
  findAction,
  isPinnable,
  pinnedActions,
  reorderPins,
  runAction,
  sanitizePins,
  sections,
  setPaletteOpener,
  setProjectActions,
  setTmuxSessionActions,
  setTuiActions,
  togglePin,
} from './actions'

// Filled thumbtack; color + opacity (via CSS) distinguish pinned from unpinned.
const PIN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><rect x="11" y="11" width="2" height="9" rx="1"/></svg>'

type TuiInfo = { slug: string; displayName: string; accent: string }
type ProjectInfo = { id: string; name: string; current: boolean }
type TmuxSessionInfo = { id: string; label: string; source: string }

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
// TUIs for the "New widget" flyout (fetched once at init). The flyout is one
// shared element appended to the shell — like the tooltip — because the menu
// itself clips horizontally (overflow-y:auto), so a child popover would be cut off.
let tuis: TuiInfo[] = []
// Workspaces for the "Open workspace" flyout (fetched once at init), same pattern.
let projects: ProjectInfo[] = []
let tmuxSessions: TmuxSessionInfo[] = []
let submenuEl: HTMLElement

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

// Shortcut chips for a key chord ("Ctrl+Shift+M"); a single mono token for CLI verbs.
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
// Replace-with-<TUI> actions kill whatever's running in the focused pane, and the
// launchers can be pinned to the titlebar where a stray click is easy. So they
// arm on the first click (the icon/row shows an "armed" pulse + a "click again"
// tip) and only run on a deliberate second click within ARM_MS. Any timeout,
// mouse-leave, or other click disarms.
const ARM_MS = 3000
let armedEl: HTMLElement | null = null
let armTimer: number | undefined

function needsConfirm(id: string): boolean {
  // All destructive to the focused pane's session, so all arm before they fire:
  // replace = different TUI, project = same TUI in a new dir, retire = end the pane.
  return id.startsWith('replace:') || id.startsWith('project:') || id === 'retire-widget'
}

function disarm(): void {
  if (armedEl) {
    armedEl.classList.remove('armed')
    armedEl = null
  }
  if (armTimer) {
    clearTimeout(armTimer)
    armTimer = undefined
  }
}

// Returns true if this click only ARMED the action (caller must not run it yet);
// false means run now (either a non-guarded action or the confirming 2nd click).
function armGuard(id: string, el: HTMLElement, placement: 'left' | 'below'): boolean {
  if (!needsConfirm(id)) return false
  if (armedEl === el) {
    disarm() // second click on the same target → confirm
    return false
  }
  disarm() // clear any other armed target first
  armedEl = el
  el.classList.add('armed')
  const a = findAction(id)
  if (a) showArmTip(el, a, placement)
  armTimer = window.setTimeout(disarm, ARM_MS)
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

function menuRow(a: Action): HTMLElement {
  const row = make('div', 'aico-row')
  row.dataset.id = a.id
  const flyoutKind = FLYOUTS[a.id]

  const ic = make('span', 'aico-ic')
  ic.textContent = a.icon
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
      if (armedEl === row) disarm()
    })
  }

  // Rows that own a picker flyout: "New widget" (kind 'new', new widgets),
  // "Replace TUI" (kind 'replace', the focused widget), "Open workspace" (kind
  // 'project', rebinds the focused widget), and "Attach tmux session" (kind
  // 'tmux'). Hovering or clicking opens the choices; the flyout replaces the
  // left tooltip for these rows.
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
type FlyoutKind = 'new' | 'replace' | 'project' | 'tmux'
const FLYOUTS: Partial<Record<string, FlyoutKind>> = {
  'new-widget': 'new',
  'replace-tui': 'replace',
  'switch-project': 'project',
  'attach-tmux': 'tmux',
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
    if (armedEl === item) disarm()
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
  const dot = make('span', 'aico-sub-dot')
  dot.style.background = t.accent
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
    closeMenu() // tidies up in both the drilled-menu and standalone-popup cases
    window.aico.actions.newWidget(slug, p.id)
  })
  return item
}

// Fill the shared flyout with the workspace picker for `slug` (the second level of
// "New widget"). `withBack` adds a row back to the TUI list — present in the menu
// drill-down, absent in the standalone popup (pinned icon / palette), which has
// nothing to go back to.
function populateNewProjects(slug: string, withBack: boolean): void {
  submenuEl.innerHTML = ''
  if (withBack) {
    const back = make('div', 'aico-sub-row aico-sub-back runnable')
    const lbl = make('span', 'aico-lbl')
    lbl.textContent = '‹ New widget'
    back.append(lbl)
    back.addEventListener('click', (e) => {
      e.stopPropagation() // same as newTuiRow: repopulating wipes this row, so don't let the bubble close the menu
      populateSubmenu('new')
    })
    submenuEl.append(back)
  }
  if (projects.length) {
    for (const p of projects) submenuEl.append(newProjectRow(slug, p))
  } else {
    const empty = make('div', 'aico-sub-row empty')
    empty.textContent = 'No workspaces'
    submenuEl.append(empty)
  }
}

function emptySubmenuRow(label: string): HTMLElement {
  const empty = make('div', 'aico-sub-row empty')
  empty.textContent = label
  return empty
}

// Fill the shared flyout for `kind`. 'new': TUI rows that drill into a workspace
// picker. 'replace': TUI rows that replace the focused pane (launcher
// `replace:<slug>`). 'project': workspace rows that rebind the focused widget
// (`project:<id>`). 'replace'/'project' rows carry a pin button.
function populateSubmenu(kind: FlyoutKind): void {
  submenuEl.innerHTML = ''
  if (kind === 'new') {
    if (tuis.length) {
      for (const t of tuis) submenuEl.append(newTuiRow(t))
    } else {
      submenuEl.append(emptySubmenuRow('No TUIs'))
    }
  } else if (kind === 'project') {
    if (projects.length) {
      for (const p of projects) {
        submenuEl.append(
          submenuRow(`project:${p.id}`, p.name, (dot) => {
            dot.classList.add('project') // neutral ring; .current fills it (see CSS)
            dot.classList.toggle('current', p.current)
          }),
        )
      }
    } else {
      submenuEl.append(emptySubmenuRow('No workspaces'))
    }
  } else if (kind === 'tmux') {
    if (tmuxSessions.length) {
      for (const session of tmuxSessions) {
        submenuEl.append(
          submenuRow(`tmux:${session.id}`, session.label, (dot) => {
            dot.classList.add('project')
          }),
        )
      }
    } else {
      submenuEl.append(emptySubmenuRow('No tmux sessions'))
    }
  } else {
    if (tuis.length) {
      for (const t of tuis) {
        submenuEl.append(
          submenuRow(`replace:${t.slug}`, t.displayName, (dot) => {
            dot.style.background = t.accent
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
function placeSubmenu(anchor: HTMLElement, placement: 'left' | 'below'): void {
  const shell = submenuEl.offsetParent as HTMLElement | null
  if (!shell) return
  const s = shell.getBoundingClientRect()
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

// Open a `kind` flyout from its menu row (part of the lantern menu).
function showSubmenu(row: HTMLElement, kind: FlyoutKind): void {
  submenuStandalone = false
  populateSubmenu(kind)
  submenuEl.hidden = false // unhide before measuring
  placeSubmenu(row, 'left')
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
}

function hideSubmenu(): void {
  if (submenuEl) submenuEl.hidden = true
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
  disarm()
}
function toggleMenu(): void {
  if (menuOpen()) closeMenu()
  else openMenu()
}

// ---- pinned cluster --------------------------------------------------------

function clusterIcon(a: Action, index: number): HTMLElement {
  const b = make('button', 'aico-pin-icon')
  b.type = 'button'
  b.textContent = a.icon
  if (a.accent) b.style.color = a.accent // per-TUI launchers read as their accent
  b.draggable = true
  attachTip(b, a, 'below') // styled tooltip instead of the native title
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
    if (armedEl === b) disarm()
  })
  b.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/plain', String(index))
    b.classList.add('dragging')
  })
  b.addEventListener('dragend', () => b.classList.remove('dragging'))
  b.addEventListener('dragover', (e) => e.preventDefault())
  b.addEventListener('drop', (e) => {
    e.preventDefault()
    const from = Number(e.dataTransfer?.getData('text/plain'))
    if (!Number.isNaN(from)) commitPins(reorderPins(pins, from, index))
  })
  return b
}

function renderCluster(): void {
  clusterEl.innerHTML = ''
  pinnedActions(pins).forEach((a, i) => {
    clusterEl.append(clusterIcon(a, i))
  })
}

// ---- command palette -------------------------------------------------------

function runnableMatches(query: string): Action[] {
  const q = query.trim().toLowerCase()
  const runnable = allActions().filter(isPinnable)
  if (!q) return runnable
  return runnable.filter(
    (a) => a.label.toLowerCase().includes(q) || a.section.toLowerCase().includes(q),
  )
}

function setPaletteSel(i: number): void {
  paletteSel = i
  ;[...paletteList.children].forEach((c, idx) => {
    c.classList.toggle('sel', idx === i)
  })
}

function renderPaletteList(): void {
  paletteItems = runnableMatches(paletteInput.value)
  paletteList.innerHTML = ''
  paletteItems.forEach((a, i) => {
    const row = make('div', 'aico-palette-item')
    if (i === 0) row.classList.add('sel')
    const ic = make('span', 'aico-ic')
    ic.textContent = a.icon
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
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setPaletteSel(Math.min(paletteSel + 1, paletteItems.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setPaletteSel(Math.max(paletteSel - 1, 0))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const a = paletteItems[paletteSel]
    if (!a) return
    const row = paletteList.children[paletteSel] as HTMLElement | undefined
    // Mirror the click path (see renderPaletteList): first Enter on a guarded
    // action (replace:/project:/retire-widget) only arms it; a second Enter
    // confirms. Without this the keyboard path destroys a running session on a
    // single keystroke.
    if (row && armGuard(a.id, row, 'below')) return
    paletteActivate(a)
  } else if (e.key === 'Escape') {
    e.preventDefault()
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
  disarm()
  window.dispatchEvent(new CustomEvent('aico:refocus')) // hand focus back to the terminal
}

// ---- shared pin commit -----------------------------------------------------

function commitPins(next: string[]): void {
  pins = next
  window.aico.settings.setPins(next) // persists + broadcasts to all widgets
  renderCluster()
  syncMenuPinStates()
}

async function loadPins(): Promise<string[]> {
  const stored = await window.aico.settings.getPins()
  if (stored == null) {
    const seed = sanitizePins(DEFAULT_PINS) // first run
    window.aico.settings.setPins(seed)
    return seed
  }
  const clean = sanitizePins(stored)
  if (clean.length !== stored.length) window.aico.settings.setPins(clean) // heal stale ids
  return clean
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
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false
  switch (e.code) {
    case 'KeyP':
      openPalette()
      return true
    case 'KeyH':
      runAction('hub')
      return true
    case 'KeyR':
      runAction('refresh')
      return true
    default:
      return false
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

  // TUI picker flyout: fetch the registry list and register the per-TUI actions
  // before pins load (so pinned new:/replace: ids survive sanitization) and
  // before buildMenu(), which reads `tuis.length` to decide whether to wire the
  // picker rows. The flyout is populated per-kind on hover (showSubmenu).
  try {
    tuis = await window.aico.actions.listTuis()
  } catch {
    tuis = [] // no picker; the "New widget" row then has nothing to launch
  }
  setTuiActions(tuis)
  // Workspaces for the "Open workspace" flyout, same lifecycle as the TUI list:
  // registered before pins load (so pinned project:<id> survive sanitization) and
  // before buildMenu() (which wires rows against this catalog).
  try {
    projects = await window.aico.actions.listProjects()
  } catch {
    projects = [] // no workspace catalog; the "Open workspace" row simply stays inert
  }
  setProjectActions(projects)
  try {
    tmuxSessions = await window.aico.actions.listTmuxSessions()
  } catch {
    tmuxSessions = []
  }
  setTmuxSessionActions(tmuxSessions)
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
    pins = sanitizePins(ids)
    renderCluster()
    syncMenuPinStates()
  })

  window.aico.settings.onTerminalFontChanged((settings) => {
    terminalFontSettings = parseTerminalFontSettings(settings)
    syncTerminalFontControls()
  })
}
