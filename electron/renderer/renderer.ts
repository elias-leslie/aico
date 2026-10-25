import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { createPasteGuard } from './paste-guard'
import '@xterm/xterm/css/xterm.css'
import './tokens.css'
import '../../assets/fonts/fonts.css'
import './chrome.css'
import './control-surface.css'
import {
  type AicoTerminalFontSettings,
  fontFamilyFor,
  fontLoadFaceFor,
  parseTerminalFontSettings,
  SYMBOLS_FACE,
  SYMBOLS_SAMPLE,
} from '../shared/font-settings'
import { mouseReportingActive, programOwnsSelection, setupMouseShim } from '../shared/mouse-shim'
import { BONE, INK } from '../shared/palette'
import { TERMINAL_HISTORY_LINES } from '../shared/terminal-history'
import {
  AICO_TOAST_EVENT,
  type AicoToastDetail,
  setCoordinatorAction,
  setGameActions,
} from './actions'
import { GAMES } from './arcade/games'
import { type ArcadeWiring, wireArcade } from './arcade/wire'
import { WINDOW_CHORDS } from './chords'
import { initControlSurface } from './control-surface'
import { controlWheelAction, swallowQueryReplies, trackSgrMouse } from './control-view'
import { wireDraftInput } from './draft-input'
import { Eyes } from './eyes'
import { urlAt } from './links'
import { pointToCell, sgrWheelSequence, wheelMouseTicks } from './mouse-wheel'
import { osc52Text } from './osc52'
import { terminalShouldTakeFocus } from './terminal-focus'
import { wheelLineDelta } from './wheel'

const host = document.getElementById('terminal')
if (!host) {
  throw new Error('terminal mount point missing')
}
const terminalHost = host

const theme = { background: INK, foreground: BONE }
let terminalFontSettings = parseTerminalFontSettings(await window.aico.settings.getTerminalFont())
let fontFamily = fontFamilyFor(terminalFontSettings.fontId)
let fontSize = terminalFontSettings.fontSize
let tuiSlug = 'shell'
let terminalLayoutReady = false
let terminalLayoutTimer: number | undefined
// Control mode feeds xterm the pane's own output, so xterm keeps the history
// and the program's modes itself.
const term = new Terminal({
  fontFamily,
  fontSize,
  scrollback: TERMINAL_HISTORY_LINES,
  // A blinking xterm cursor kept every large transparent widget repainting even
  // when its session was idle; three visible 4K-scale windows held Chromium's
  // GPU process near one-third of a core. A static cursor preserves location
  // without creating a permanent render loop.
  cursorBlink: false,
  theme,
  allowProposedApi: true,
  // OSC 8 hyperlinks (a program's own links): Ctrl+click opens them.
  linkHandler: {
    activate: (event, uri) => {
      if (event.ctrlKey) window.aico.links.open(uri)
    },
  },
})

// Ctrl+click a plain URL to open it, even inside mouse-grabbing TUIs: read the
// clicked row from the buffer (wrapped rows joined) and find the URL there.
host.addEventListener(
  'mousedown',
  (event) => {
    if (event.button !== 0 || !event.ctrlKey) return
    const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
    if (!screen || screen.width === 0 || screen.height === 0) return
    const col = Math.floor(((event.clientX - screen.left) / screen.width) * term.cols)
    const row = Math.floor(((event.clientY - screen.top) / screen.height) * term.rows)
    if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return
    const buffer = term.buffer.active
    let first = buffer.viewportY + row
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--
    let text = ''
    let offset = 0
    for (let y = first; ; y++) {
      const line = buffer.getLine(y)
      if (!line || (y > first && !line.isWrapped)) break
      if (y === buffer.viewportY + row) offset = text.length
      text += line.translateToString(false)
    }
    const url = urlAt(text, offset + col)
    if (!url) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.aico.links.open(url)
  },
  { capture: true },
)

// The wheel is routed in the capture handler below (controlWheel), leaving xterm
// only the mouse reports it encodes itself.
let sgrMouse = () => false

/** Act on a wheel event, or return false to leave it to xterm. */
function controlWheel(e: WheelEvent): boolean {
  const action = controlWheelAction({
    mouseTracking: mouseReportingActive(term),
    sgrMouse: sgrMouse(),
    alternateScreen: term.buffer.active.type === 'alternate',
  })
  if (action === 'xterm-report') return false
  if (action === 'forward-sgr') forwardWheel(e)
  // xterm's own speed is ~3 lines a notch; this matches the web app's.
  else if (action === 'scroll') term.scrollLines(wheelLineDelta(e.deltaY))
  return true
}

/** Send a wheel event to the program as SGR reports, one per notch's worth. */
function forwardWheel(wheel: {
  deltaY: number
  deltaMode: number
  clientX: number
  clientY: number
}): void {
  const screen = terminalHost.querySelector<HTMLElement>('.xterm-screen')
  const cellHeight = screen ? screen.clientHeight / Math.max(term.rows, 1) : 0
  const ticks = wheelMouseTicks(wheel.deltaY, wheel.deltaMode, cellHeight, term.rows)
  if (ticks === 0) return
  const { column, row } = pointToCell(screen, term.cols, term.rows, wheel.clientX, wheel.clientY)
  const sequence = sgrWheelSequence(wheel.deltaY > 0 ? 'down' : 'up', column, row)
  for (let tick = 0; tick < ticks; tick += 1) window.aico.pty.input(sequence)
}

const fit = new FitAddon()
term.loadAddon(fit)

// Single debounced fit shared by every layout-change source (window resize,
// draft input, font change). Two independent debouncers used to be
// able to fire fit+resize back-to-back mid-output — exactly the racing-reflow
// garble the debounce exists to prevent — so all paths coalesce here.
function scheduleTerminalLayoutFit(): void {
  if (!terminalLayoutReady) return
  if (terminalLayoutTimer) clearTimeout(terminalLayoutTimer)
  terminalLayoutTimer = window.setTimeout(() => {
    fit.fit()
    window.aico.pty.resize({ cols: term.cols, rows: term.rows })
  }, 60)
}

// Window chrome: controls, focus state, custom SE resize. Independent of the
// terminal, so wire it up before the (async) font-gated terminal open.
function wireChrome(): void {
  document.querySelector('.ctl.min')?.addEventListener('click', () => window.aico.win.minimize())
  document
    .querySelector('.ctl.max')
    ?.addEventListener('click', () => window.aico.win.toggleMaximize())
  document.querySelector('.ctl.close')?.addEventListener('click', () => window.aico.win.close())

  window.aico.win.onFocusChange((focused) => {
    document.body.classList.toggle('unfocused', !focused)
  })

  // Frameless windows have no native edge resize, so each handle drags the
  // window's bounds. West/north edges move the origin too (setBounds, not just
  // size); on pure Wayland the compositor may ignore origin moves.
  const MIN_W = 360
  const MIN_H = 240
  const dirs: Record<string, { n?: boolean; s?: boolean; e?: boolean; w?: boolean }> = {
    n: { n: true },
    s: { s: true },
    e: { e: true },
    w: { w: true },
    ne: { n: true, e: true },
    nw: { n: true, w: true },
    se: { s: true, e: true },
    sw: { s: true, w: true },
  }
  for (const [name, d] of Object.entries(dirs)) {
    const el = document.querySelector<HTMLElement>(`.rz.${name}`)
    el?.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault()
      const px = e.screenX
      const py = e.screenY
      const bx = window.screenX
      const by = window.screenY
      const bw = window.outerWidth
      const bh = window.outerHeight
      el.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent): void => {
        const dx = ev.screenX - px
        const dy = ev.screenY - py
        let x = bx
        let y = by
        let w = bw
        let h = bh
        if (d.e) w = Math.max(MIN_W, bw + dx)
        if (d.s) h = Math.max(MIN_H, bh + dy)
        if (d.w) {
          w = Math.max(MIN_W, bw - dx)
          x = bx + (bw - w)
        }
        if (d.n) {
          h = Math.max(MIN_H, bh - dy)
          y = by + (bh - h)
        }
        window.aico.win.setBounds(x, y, w, h)
      }
      const up = (ev: PointerEvent): void => {
        el.releasePointerCapture(ev.pointerId)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    })
  }
}

wireChrome()

// Aico's eyes — the widget's face (see eyes.ts). Unfocused or hovered, they
// follow the cursor (fed from main over win:cursor); terminal output and typing
// reach them below.
function wireEyes(): Eyes | null {
  const root = document.querySelector<HTMLElement>('#eyes')
  if (!root) return null
  const face = new Eyes(root, document.querySelector<HTMLElement>('#tui-icon'))
  window.aico.win.onCursor((pt) => face.cursor(pt.x, pt.y))
  window.aico.win.onFocusChange((focused) => face.setFocused(focused))
  window.aico.win.onPeerLook((look) => face.lookAtPeer(look.x, look.y, look.delay, look.hold))
  window.aico.win.onAttention((a) => face.setAttention(a.mode, a.stage))
  const r = root.getBoundingClientRect()
  window.aico.win.setEyeAnchor({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  const titlebar = document.querySelector<HTMLElement>('.titlebar')
  titlebar?.addEventListener('mousemove', (e) => face.hover(e))
  titlebar?.addEventListener('mouseleave', () => face.hover(null))
  return face
}
const eyes = wireEyes()

// The titlebar arcade (see arcade/wire.ts): a game per window, on unless
// turned off for every window; the engine loads only while the games are on.
let arcade: ArcadeWiring | null = null
{
  const bar = document.querySelector<HTMLElement>('.titlebar')
  if (bar) {
    arcade = wireArcade(bar, {
      api: window.aico.arcade,
      events: window,
      gaze: (pt) => eyes?.watch(pt),
    })
    // asleep eyes: the game naps (plays its nap briefly, then parks)
    eyes?.onSleep((asleep) => arcade?.nap(asleep))
    setGameActions(GAMES)
  }
}

// A coordinator (a session that launched lanes) and each of its lanes carry a
// titlebar chip in the coordinator's colour (chrome.css): `Coordinator`, or
// `↳ <coordinator>` on a lane. A coordinator's menu toggle reads Unmark.
function showCoordinator(coordinator: boolean, chip: { text: string; color: string } | null): void {
  if (coordinator) document.documentElement.dataset.role = 'coordinator'
  else if (chip) document.documentElement.dataset.role = 'lane'
  else delete document.documentElement.dataset.role
  const el = document.querySelector<HTMLElement>('#role-chip')
  if (el) {
    el.hidden = !chip
    el.textContent = chip?.text ?? ''
    el.title = chip?.text ?? ''
    if (chip) el.style.setProperty('--chip', chip.color)
    else el.style.removeProperty('--chip')
  }
  setCoordinatorAction(coordinator)
}

// Titlebar identity (so several open widgets are distinguishable at a glance):
// the TUI's SVG mark (in its accent) set between the eyes, and a click-to-rename
// widget name in the available title lane. Fed by main over win:title; the OS window
// title is kept in sync too (for the taskbar / alt-tab list).
function wireTitle(): void {
  const nameBtn = document.querySelector<HTMLButtonElement>('#wname')
  const nameInput = document.querySelector<HTMLInputElement>('#wname-input')
  const iconEl = document.querySelector<HTMLElement>('#tui-icon')
  if (!nameBtn || !nameInput || !iconEl) return

  let customName = '' // the user-set name ('' ⇒ unnamed; the button shows the fallback)

  window.aico.win.onTitle((info) => {
    nameBtn.textContent = info.label
    nameBtn.title = info.label
    nameBtn.setAttribute('aria-label', `Rename session: ${info.label}`)
    customName = info.name ?? ''

    // Static, developer-authored SVG from the TUI spec (never user input), so
    // innerHTML is safe here — unlike the selection toast, which is untrusted.
    iconEl.innerHTML = info.icon
    iconEl.style.color = info.accent || ''
    eyes?.setAccent(info.accent)
    iconEl.title = info.tuiName
    tuiSlug = info.tuiSlug || 'shell'

    document.title = [info.label, info.tuiName].filter(Boolean).join(' · ')
    showCoordinator(info.coordinator, info.chip)
  })

  // Click the name to rename: swap the button for an input prefilled with the
  // custom name (Enter/blur commits, Esc cancels). An empty commit clears it.
  const beginRename = (): void => {
    nameInput.value = customName
    nameBtn.hidden = true
    nameInput.hidden = false
    nameInput.focus()
    nameInput.select()
  }
  const endRename = (commit: boolean): void => {
    if (nameInput.hidden) return
    if (commit) window.aico.win.setName(nameInput.value)
    nameInput.hidden = true
    nameBtn.hidden = false
  }
  nameBtn.addEventListener('click', beginRename)
  // The palette and session menu reach it too, for windows too narrow to show the title.
  window.addEventListener('aico:rename', beginRename)
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      endRename(true)
      nameBtn.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      endRename(false)
      nameBtn.focus()
    }
  })
  nameInput.addEventListener('blur', () => endRename(true))
}
wireTitle()

// Shared text-only status toast: selection delivery and local action confirmation
// both use this frosted pill. Content is always assigned with textContent.
function wireSelectionToast(): void {
  const toast = document.querySelector<HTMLElement>('.selection-toast')
  const chip = toast?.querySelector<HTMLElement>('.chip')
  const snip = toast?.querySelector<HTMLElement>('.snip')
  const actionButton = toast?.querySelector<HTMLButtonElement>('.toast-action')
  const dismissButton = toast?.querySelector<HTMLButtonElement>('.toast-dismiss')
  if (!toast || !chip || !snip || !actionButton || !dismissButton) return
  let hideTimer: number | undefined
  let currentAction: AicoToastDetail['action']

  const show = ({ kind, snippet, action }: AicoToastDetail): void => {
    // Expose the live region before changing its text. Updating a subtree while
    // it is `hidden` is not announced consistently by assistive technology.
    toast.hidden = false
    chip.textContent = kind
    snip.textContent = action ? snippet : snippet.slice(0, 40) // textContent, never innerHTML (untrusted)
    currentAction = action
    toast.classList.toggle('actionable', Boolean(action))
    actionButton.hidden = !action
    dismissButton.hidden = !action
    actionButton.textContent = action?.kind === 'copy' ? 'Copy' : 'Show file'
    // Reflow so the .show transition replays on a back-to-back capture.
    void toast.offsetWidth
    toast.classList.add('show')
    if (hideTimer) clearTimeout(hideTimer)
    // Handoffs stay readable and actionable until dismissed or acted on.
    if (!action) hideTimer = window.setTimeout(() => toast.classList.remove('show'), 2500)
  }

  actionButton.addEventListener('click', () => {
    if (currentAction?.kind === 'copy') {
      window.aico.clipboard.write(currentAction.text)
      actionButton.textContent = 'Copied'
    } else if (currentAction?.kind === 'file') {
      window.aico.selection.showFile(currentAction.id)
      toast.classList.remove('show')
    }
  })
  dismissButton.addEventListener('click', () => toast.classList.remove('show'))

  window.aico.selection.onToast(show)
  window.addEventListener(AICO_TOAST_EVENT, (event) => {
    show((event as CustomEvent<AicoToastDetail>).detail)
  })
  toast.addEventListener('transitionend', () => {
    if (!toast.classList.contains('show')) toast.hidden = true
  })
}

wireSelectionToast()

// Supplemental Agent Hub context status: main pushes `context:mandate` for this
// widget's TUI on load and at each launch/relaunch. Surface it two ways so
// degraded delivery stays visible without blocking the native model: a
// PERSISTENT titlebar badge — calm green when the source chain and live delivery
// availability are verified, red when delivery is unavailable or unconfirmed —
// plus a transient warning toast. This independent probe does not claim what an
// already-running session received. TUIs with no applicable hook hide it.
function wireMandate(): void {
  const badge = document.querySelector<HTMLElement>('#mandate-warn')
  const toast = document.querySelector<HTMLElement>('.mandate-toast')
  if (!badge || !toast) return
  let hideTimer: number | undefined
  window.aico.context.onMandate(({ slug, state, detail, applicable }) => {
    // No supplemental-context mechanism for this TUI (bare shell etc.) → no badge to show.
    if (!applicable) {
      badge.hidden = true
      toast.classList.remove('show')
      return
    }
    const missing = state !== 'available'
    // Persistent status badge: green tick = source chain + live availability
    // verified, red warning = delivery unavailable or unconfirmed. The tooltip
    // carries full status + detail in both states.
    badge.hidden = false
    badge.classList.toggle('ctx-missing', missing)
    badge.classList.toggle('ctx-ok', !missing)
    badge.textContent = missing ? '⚠' : '✓' // ⚠ / ✓
    badge.title = missing
      ? `${slug}: Agent Hub context delivery unavailable or unconfirmed; native model continues — ${detail}`
      : `${slug}: Agent Hub source chain and live delivery availability verified — ${detail}`
    badge.setAttribute(
      'aria-label',
      missing
        ? `${slug}: Agent Hub context delivery unavailable or unconfirmed; native model continues`
        : `${slug}: Agent Hub source chain and live delivery availability verified`,
    )
    if (!missing) {
      toast.classList.remove('show')
      return
    }
    // Transient launch toast. textContent (never innerHTML) — detail is built by
    // main but kept plain-text to match the untrusted-toast discipline above.
    toast.textContent = `⚠ ${slug}: Agent Hub context delivery unavailable or unconfirmed; native model continues`
    toast.hidden = false
    void toast.offsetWidth // reflow so .show replays on a back-to-back relaunch
    toast.classList.add('show')
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => toast.classList.remove('show'), 4500)
  })
  toast.addEventListener('transitionend', () => {
    if (!toast.classList.contains('show')) toast.hidden = true
  })
}
wireMandate()

// Control surface: lantern menu, pinned cluster, command palette. Independent of
// the terminal; the palette/menu hand focus back here on close (see below).
void initControlSurface()

// The selected font must be loaded before xterm measures its glyph cell, or the
// live view renders at fallback metrics and misaligns once the webfont swaps in.
// A face that fails to load only costs its glyphs: the terminal still opens.
async function loadTerminalFont(settings: AicoTerminalFontSettings): Promise<void> {
  const results = await Promise.allSettled([
    document.fonts.load(`${settings.fontSize}px ${fontLoadFaceFor(settings.fontId)}`),
    document.fonts.load(`${settings.fontSize}px ${SYMBOLS_FACE}`, SYMBOLS_SAMPLE),
  ])
  for (const result of results)
    if (result.status === 'rejected')
      console.warn('[aico] terminal font failed to load:', result.reason)
}

await loadTerminalFont(terminalFontSettings)

term.open(host)
// Module-level so the manual Refresh can clear its glyph atlas and a context
// loss can drop it. Undefined when WebGL is unavailable (DOM-renderer fallback).
let webgl: WebglAddon | undefined
try {
  webgl = new WebglAddon()
  // Context loss leaves the canvas frozen; dispose to fall back to the DOM
  // renderer AND repaint, or the view stays stuck on the lost frame.
  webgl.onContextLoss(() => {
    webgl?.dispose()
    webgl = undefined
    term.refresh(0, term.rows - 1)
  })
  term.loadAddon(webgl)
} catch {
  // WebGL unavailable — DOM renderer is the correct fallback.
  webgl = undefined
}
fit.fit()
swallowQueryReplies(term)
sgrMouse = trackSgrMouse(term)
wireDraftInput(term, () => tuiSlug, scheduleTerminalLayoutFit)
// Copies made inside the pane (Claude Code's own selection) arrive as OSC 52.
term.parser.registerOscHandler(52, (data) => {
  const text = osc52Text(data)
  if (text) window.aico.clipboard.write(text)
  return true
})

// Renderer -> PTY keystrokes; PTY -> renderer output. PTY output also drives the
// "thinking" heuristic: active while output flows, settled ~0.5s after it
// stops. The eyes read along and the tray icon goes amber; the window frame
// stays still, since a frame that changed color with every burst flickered.
let thinking = false
let thinkTimer: number | undefined
function setThinking(on: boolean): void {
  if (on !== thinking) {
    thinking = on
    eyes?.setBusy(on)
    arcade?.output(on)
    window.aico.win.setThinking(on) // amber tray icon while active
  }
}
function pokeThinking(): void {
  setThinking(true)
  if (thinkTimer) clearTimeout(thinkTimer)
  thinkTimer = window.setTimeout(() => {
    setThinking(false)
  }, 500)
}

term.onData((data) => {
  window.aico.pty.input(data)
  eyes?.noticeInput()
  arcade?.input()
})
window.aico.pty.onData((data) => {
  term.write(data)
  pokeThinking()
})

// Another client holds the session's size: cover the cramped pane with a notice.
// The button takes the size back deliberately; a click anywhere in the
// terminal (the notice included) and typing do too (main). The terminal keeps keyboard focus throughout.
const sizeNotice = document.getElementById('size-notice') as HTMLElement
window.aico.pty.onSizeOther((other) => {
  sizeNotice.hidden = !other
  if (!other && terminalShouldTakeFocus(document)) term.focus()
})
document.getElementById('size-notice-use')?.addEventListener('click', (event) => {
  event.stopPropagation()
  window.aico.pty.claimSize(true)
  term.focus()
})
host.addEventListener('mousedown', () => window.aico.pty.claimSize(false))

// (Re)attach the tmux session for this window at the current viewport size.
// On a renderer reload this fires again and re-attaches the same session.
window.aico.pty.start({ cols: term.cols, rows: term.rows })
terminalLayoutReady = true
scheduleTerminalLayoutFit()

// A window that comes forward (new, restored, reopened, raised by the window
// manager) types into its terminal without a click first.
if (document.hasFocus() && terminalShouldTakeFocus(document)) term.focus()
window.aico.win.onFocusChange((focused) => {
  if (focused && terminalShouldTakeFocus(document)) term.focus()
})

// Debounce resizes: a burst of observer callbacks (drag-resize, maximize) each
// reflows tmux, and racing reflows are a prime cause of duplicated/garbled
// output. Coalescing to one fit ~60ms after the last change avoids the race.
const observer = new ResizeObserver(() => scheduleTerminalLayoutFit())
observer.observe(host)

// Manual Refresh (lantern menu / palette / Ctrl+Shift+R): repair a desynced
// view without disturbing the running program. Clear the WebGL glyph atlas (a
// glitched atlas is a common corruption source), wipe the buffer CONTENT
// (term.clear keeps terminal modes — mouse reporting, bracketed paste — that a
// reset would strip from the running TUI), then have tmux re-send its grid and
// repaint every row from it. The refresh carries the live grid size so main
// can re-pair a drifted pty: when the pty believes a different size than the
// renderer, every tmux repaint wrap-garbles, and refresh-client alone can
// never fix that class of corruption.
function refreshTerminal(): void {
  webgl?.clearTextureAtlas()
  term.clear()
  window.aico.pty.refresh({ cols: term.cols, rows: term.rows })
  term.refresh(0, term.rows - 1)
}
window.addEventListener('aico:refresh', refreshTerminal)

async function applyTerminalFontSettings(settings: unknown): Promise<void> {
  const next = parseTerminalFontSettings(settings)
  if (
    next.fontId === terminalFontSettings.fontId &&
    next.fontSize === terminalFontSettings.fontSize
  ) {
    return
  }
  terminalFontSettings = next
  await loadTerminalFont(next)
  fontFamily = fontFamilyFor(next.fontId)
  fontSize = next.fontSize
  term.options.fontFamily = fontFamily
  term.options.fontSize = fontSize
  fit.fit()
  window.aico.pty.resize({ cols: term.cols, rows: term.rows })
  term.focus()
}

// Drag-select copies to the system clipboard; the mouse-shim makes this work
// even inside mouse-reporting TUIs (Claude Code). Right-click and Ctrl+Shift+V
// paste via term.paste (bracketed when the app enabled it, so multi-line pastes
// don't auto-execute); Ctrl+Shift+C copies. Paste only matters on the live term.
// Copy the completed selection on mouse release (left button) rather than on
// every xterm onSelectionChange tick — that fires per-cell during a drag and
// would clobber the system clipboard mid-drag with dozens of partial writes.
// The shim re-dispatches a synthetic mouseup inside mouse-reporting TUIs, so
// this still fires there.
host.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return
  const selection = term.getSelection()
  if (selection) window.aico.clipboard.write(selection)
})

// One gesture, one paste: see paste-guard.ts for the duplicate sources.
// An image-only clipboard (a screenshot) is saved to a file by main and its
// path is pasted as text: Claude Code and Codex attach an image when a pasted
// path points at one. Ctrl+V would make the program read the clipboard itself,
// which fails when it runs as another user with no display.
const pasteFromClipboard = createPasteGuard(
  async () => (await window.aico.clipboard.read()) || (await window.aico.clipboard.imagePath()),
  // tmux pastes, bracketed when the program asked.
  (text) => window.aico.pty.paste(text),
)

host.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  event.stopPropagation()
  void pasteFromClipboard()
})

term.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) {
    return true
  }
  if (event.code === WINDOW_CHORDS.paste) {
    // xterm skips preventDefault when this handler returns false, so Chromium
    // would also fire a native paste event into xterm's textarea: a second paste.
    event.preventDefault()
    void pasteFromClipboard()
    return false
  }
  if (event.code === WINDOW_CHORDS.copy) {
    const selection = term.getSelection()
    if (selection) window.aico.clipboard.write(selection)
    return false
  }
  return true
})

// The palette/menu hand focus back to the terminal when they close.
window.addEventListener('aico:refocus', () => term.focus())

// Decided once per press so a drag never switches owner halfway through.
let shimForcesDrag = true
setupMouseShim(term, host, (e) => {
  if (e.type === 'mousedown') shimForcesDrag = !paneOwnsSelection()
  return shimForcesDrag
})

window.aico.settings.onTerminalFontChanged((settings) => {
  void applyTerminalFontSettings(settings)
})

function paneOwnsSelection(): boolean {
  return programOwnsSelection({
    tuiSlug,
    alternateScreen: term.buffer.active.type === 'alternate',
    mouseReporting: mouseReportingActive(term),
  })
}

// The wheel is routed here, ahead of xterm, whose viewport scrolls its history
// at its own speed.
host.addEventListener(
  'wheel',
  (e) => {
    if (e.deltaY === 0 || !controlWheel(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  },
  { passive: false, capture: true },
)
