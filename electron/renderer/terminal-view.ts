import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  type AicoTerminalFontSettings,
  fontFamilyFor,
  fontLoadFaceFor,
  parseTerminalFontSettings,
  SYMBOLS_FACE,
  SYMBOLS_SAMPLE,
} from '../../shared/font-settings'
import { hostNoticeCopy } from '../../shared/host-notice'
import { mouseReportingActive, programOwnsSelection, setupMouseShim } from '../../shared/mouse-shim'
import { BONE, INK } from '../../shared/palette'
import { SIZE_HOLDER_HINT, sizeHolderName } from '../../shared/size-holder-copy'
import { TERMINAL_HISTORY_LINES } from '../../shared/terminal-history'
import { showToast } from './actions'
import { WINDOW_CHORDS } from './chords'
import { controlWheelAction, swallowQueryReplies, trackSgrMouse } from './control-view'
import { wireDraftInput } from './draft-input'
import { urlAt } from './links'
import { pointToCell, sgrWheelSequence, wheelMouseTicks } from './mouse-wheel'
import { osc52Text } from './osc52'
import { createPasteGuard } from './paste-guard'
import { terminalShouldTakeFocus } from './terminal-focus'
import { wheelLineDelta } from './wheel'
import { arcade, eyes, tuiSlug } from './window-frame'

const host = document.getElementById('terminal')
const screenHost = document.getElementById('terminal-screen')
if (!host || !screenHost) {
  throw new Error('terminal mount point missing')
}
const terminalHost = host

const theme = { background: INK, foreground: BONE }
let terminalFontSettings = parseTerminalFontSettings(await window.aico.settings.getTerminalFont())
let fontFamily = fontFamilyFor(terminalFontSettings.fontId)
let fontSize = terminalFontSettings.fontSize
let terminalLayoutReady = false
let terminalLayoutTimer: number | undefined
// Another client holds the session's size: the terminal is shown at it
// instead of fitting this window (null: fit).
let viewSize: { cols: number; rows: number } | null = null
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
    // Shown at another client's size, the terminal keeps it; this client's own
    // size still follows the window (it is what Use here or typing claims).
    if (viewSize) {
      const own = fit.proposeDimensions()
      if (own) window.aico.pty.resize({ cols: own.cols, rows: own.rows })
      return
    }
    fit.fit()
    window.aico.pty.resize({ cols: term.cols, rows: term.rows })
  }, 60)
}

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

term.open(screenHost)
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

// Another client holds the session's size: show the session at that size
// (scrolling when it is larger than this window, letterboxed when smaller)
// under a slim bar naming the client. The button takes the size back
// deliberately; a click anywhere in the terminal (the bar included), typing
// and pasting do too (main). The terminal keeps keyboard focus throughout.
const sizeBar = document.getElementById('size-bar') as HTMLElement
const sizeBarName = document.getElementById('size-bar-name') as HTMLElement
const sizeBarHint = document.getElementById('size-bar-hint') as HTMLElement
window.aico.pty.onSizeOther((held) => {
  sizeBar.hidden = !held
  if (held) {
    sizeBarName.textContent = `Sized for ${sizeHolderName(held.viewer)}`
    sizeBarHint.textContent = SIZE_HOLDER_HINT
  }
  const shown = held?.size ?? null
  viewSize = shown
  screenHost.classList.toggle('held-elsewhere', !!shown)
  if (shown) {
    if (term.cols !== shown.cols || term.rows !== shown.rows) term.resize(shown.cols, shown.rows)
  } else {
    screenHost.scrollTo(0, 0)
    fit.fit()
  }
  if (!held && terminalShouldTakeFocus(document)) term.focus()
})
document.getElementById('size-bar-use')?.addEventListener('click', (event) => {
  event.stopPropagation()
  window.aico.pty.claimSize(true)
  term.focus()
})
host.addEventListener('mousedown', () => window.aico.pty.claimSize(false))

// The session runs on another host that cannot be reached right now: the
// terminal is covered and takes no input until the host is back.
const hostNotice = document.getElementById('host-notice') as HTMLElement
const hostTitle = document.getElementById('host-notice-title') as HTMLElement
const hostDetail = document.getElementById('host-notice-detail') as HTMLElement
const hostReconnect = document.getElementById('host-notice-reconnect') as HTMLButtonElement
const hostPower = document.getElementById('host-notice-power') as HTMLButtonElement
const hostError = document.getElementById('host-notice-error') as HTMLElement
let noticeHost: string | null = null
window.aico.pty.onHost(({ host, state }) => {
  const copy = host ? hostNoticeCopy(host, state) : null
  hostNotice.hidden = !copy
  // A new state: Power on is fresh again (the host is coming up, back, or off).
  hostPower.disabled = false
  hostPower.textContent = 'Power on'
  hostError.hidden = true
  if (!copy) return
  noticeHost = host
  hostTitle.textContent = copy.title
  hostDetail.textContent = copy.detail
  hostReconnect.hidden = !copy.reconnect
  hostPower.hidden = !copy.powerOn
})
hostReconnect.addEventListener('click', (event) => {
  event.stopPropagation()
  window.aico.pty.reconnect()
})
hostPower.addEventListener('click', (event) => {
  event.stopPropagation()
  const host = noticeHost
  if (!host) return
  hostPower.disabled = true
  hostPower.textContent = 'Powering on…'
  hostError.hidden = true
  void window.aico.hosts.power(host, 'on').then((answer) => {
    if (answer.ok) return
    hostPower.disabled = false
    hostPower.textContent = 'Power on'
    hostError.textContent = answer.message || `Couldn’t power on ${host}.`
    hostError.hidden = false
  })
})

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
  // Shown at another client's size, the grid to re-pair is this window's own.
  const own = viewSize ? fit.proposeDimensions() : undefined
  window.aico.pty.refresh(
    own ? { cols: own.cols, rows: own.rows } : { cols: term.cols, rows: term.rows },
  )
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
  if (viewSize) scheduleTerminalLayoutFit()
  else {
    fit.fit()
    window.aico.pty.resize({ cols: term.cols, rows: term.rows })
  }
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
// An image-only clipboard (a screenshot) is saved to a file by main (on the
// session's host, for a remote session) and its path is pasted as text: Claude
// Code and Codex attach an image when a pasted path points at one. Ctrl+V would
// make the program read the clipboard itself, which fails when it runs as
// another user with no display. An image that didn't get there says why.
async function clipboardPasteText(): Promise<string> {
  const text = await window.aico.clipboard.read()
  if (text) return text
  const image = await window.aico.clipboard.imagePath()
  if (image.error) showToast({ kind: 'Paste', snippet: image.error })
  return image.path
}
const pasteFromClipboard = createPasteGuard(
  clipboardPasteText,
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
    // Shown at a wider client's size: Shift+wheel scrolls across it.
    if (viewSize && e.shiftKey) return
    if (e.deltaY === 0 || !controlWheel(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  },
  { passive: false, capture: true },
)
