import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
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
} from '../shared/font-settings'
import { AICO_TOAST_EVENT, type AicoToastDetail } from './actions'
import { initControlSurface } from './control-surface'
import { mouseReportingActive, setupMouseShim } from './mouse-shim'
import { ScrollbackOverlay } from './scrollback-overlay'
import { scrollbackWheelAction } from './scrollback-policy'
import { wireVoice } from './voice'
import { wheelLineDelta } from './wheel'

const host = document.getElementById('terminal')
if (!host) {
  throw new Error('terminal mount point missing')
}
const terminalHost = host

const theme = { background: '#0B0D11', foreground: '#E7E2D6' }
let terminalFontSettings = parseTerminalFontSettings(await window.aico.settings.getTerminalFont())
let fontFamily = fontFamilyFor(terminalFontSettings.fontId)
let fontSize = terminalFontSettings.fontSize
let tuiSlug = 'shell'
let terminalLayoutReady = false
let terminalLayoutTimer: number | undefined

const term = new Terminal({
  fontFamily,
  fontSize,
  // Scrollback lives in tmux history (surfaced via the overlay), not here — the
  // live view is tmux's alternate screen, which has no scrollback of its own.
  scrollback: 0,
  // A blinking xterm cursor kept every large transparent widget repainting even
  // when its session was idle; three visible 4K-scale windows held Chromium's
  // GPU process near one-third of a core. A static cursor preserves location
  // without creating a permanent render loop.
  cursorBlink: false,
  theme,
  allowProposedApi: true,
})

const fit = new FitAddon()
term.loadAddon(fit)

// Single debounced fit shared by every layout-change source (window resize,
// scrollback-rail toggle, font change). Two independent debouncers used to be
// able to fire fit+resize back-to-back mid-output — exactly the racing-reflow
// garble the debounce exists to prevent — so all paths coalesce here.
function scheduleTerminalLayoutFit(): void {
  if (!terminalLayoutReady) return
  if (terminalLayoutTimer) clearTimeout(terminalLayoutTimer)
  terminalLayoutTimer = window.setTimeout(() => {
    fit.fit()
    window.aico.pty.resize({ cols: term.cols, rows: term.rows })
    overlay.fitToWindow()
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

// Titlebar identity (so several open widgets are distinguishable at a glance):
// the TUI's SVG mark (in its accent) set between the eyes, and a click-to-rename
// widget name centered in the bar. Fed by main over win:title; the OS window
// title is kept in sync too (for the taskbar / alt-tab list).
function wireTitle(): void {
  const nameBtn = document.querySelector<HTMLButtonElement>('#wname')
  const nameInput = document.querySelector<HTMLInputElement>('#wname-input')
  const iconEl = document.querySelector<HTMLElement>('#tui-icon')
  if (!nameBtn || !nameInput || !iconEl) return

  let customName = '' // the user-set name ('' ⇒ unnamed; the button shows the fallback)

  window.aico.win.onTitle((info) => {
    nameBtn.textContent = info.label
    customName = info.name ?? ''

    // Static, developer-authored SVG from the TUI spec (never user input), so
    // innerHTML is safe here — unlike the selection toast, which is untrusted.
    iconEl.innerHTML = info.icon
    iconEl.style.color = info.accent || ''
    iconEl.title = info.tuiName
    const nextTuiSlug = info.tuiSlug || 'shell'
    const railWasReserved = terminalHost.classList.contains('tui-scrollback-rail')
    tuiSlug = nextTuiSlug
    terminalHost.classList.toggle('tui-scrollback-rail', tuiSlug !== 'shell')
    if (terminalHost.classList.contains('tui-scrollback-rail') !== railWasReserved) {
      scheduleTerminalLayoutFit()
    }

    document.title = [info.label, info.tuiName].filter(Boolean).join(' · ')
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
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      endRename(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      endRename(false)
    }
  })
  nameInput.addEventListener('blur', () => endRename(true))
}
wireTitle()

// Aico's eyes (focus cue + personality). Focused: pupils rest forward with random
// blinks and the occasional small glance. Unfocused: pupils track the global mouse
// cursor (fed from main over win:cursor). Purely cosmetic — status stays on the glow.
function wireEyes(): void {
  const eyes = [...document.querySelectorAll<HTMLElement>('.eye')]
  const pupils = eyes.map((e) => e.querySelector<HTMLElement>('.pupil'))
  if (!eyes.length) return
  const MAX = 3 // px a pupil can travel from center before it would leave the socket
  let focused = !document.body.classList.contains('unfocused')

  function look(px: number, py: number): void {
    for (const p of pupils) {
      if (!p) continue
      p.style.setProperty('--px', `${px.toFixed(1)}px`)
      p.style.setProperty('--py', `${py.toFixed(1)}px`)
    }
  }
  // Aim each pupil toward a screen-space point (the cursor), clamped in-socket.
  function aimAt(screenX: number, screenY: number): void {
    eyes.forEach((eye, i) => {
      const p = pupils[i]
      if (!p) return
      const r = eye.getBoundingClientRect()
      const dx = screenX - (window.screenX + r.left + r.width / 2)
      const dy = screenY - (window.screenY + r.top + r.height / 2)
      const d = Math.hypot(dx, dy) || 1
      const k = Math.min(MAX, d) / d
      p.style.setProperty('--px', `${(dx * k).toFixed(1)}px`)
      p.style.setProperty('--py', `${(dy * k).toFixed(1)}px`)
    })
  }

  window.aico.win.onCursor((pt) => {
    if (!focused) aimAt(pt.x, pt.y)
  })
  window.aico.win.onFocusChange((isFocused) => {
    focused = isFocused
    if (focused) look(0, 0) // settle back to a forward stare
  })

  // Random blinks (both eyes together).
  function blink(): void {
    for (const eye of eyes) eye.classList.add('blink')
    setTimeout(() => {
      for (const eye of eyes) eye.classList.remove('blink')
    }, 120)
    setTimeout(blink, 2400 + Math.random() * 4200)
  }
  setTimeout(blink, 1500 + Math.random() * 2500)

  // Idle saccades: while focused, occasionally glance off-center, then return.
  function saccade(): void {
    if (focused && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * (MAX - 1)
      look(Math.cos(a) * r, Math.sin(a) * r)
      setTimeout(
        () => {
          if (focused) look(0, 0)
        },
        550 + Math.random() * 750,
      )
    }
    setTimeout(saccade, 1900 + Math.random() * 2700)
  }
  setTimeout(saccade, 2200)

  look(0, 0)
}
wireEyes()

// Shared text-only status toast: selection delivery and local action confirmation
// both use this frosted pill. Content is always assigned with textContent.
function wireSelectionToast(): void {
  const toast = document.querySelector<HTMLElement>('.selection-toast')
  const chip = toast?.querySelector<HTMLElement>('.chip')
  const snip = toast?.querySelector<HTMLElement>('.snip')
  if (!toast || !chip || !snip) return
  let hideTimer: number | undefined

  const show = ({ kind, snippet }: AicoToastDetail): void => {
    // Expose the live region before changing its text. Updating a subtree while
    // it is `hidden` is not announced consistently by assistive technology.
    toast.hidden = false
    chip.textContent = kind
    snip.textContent = snippet.slice(0, 40) // textContent, never innerHTML (untrusted)
    // Reflow so the .show transition replays on a back-to-back capture.
    void toast.offsetWidth
    toast.classList.add('show')
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => toast.classList.remove('show'), 2500)
  }

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
// PERSISTENT titlebar badge — calm green when the adapter and live delivery are
// verified, red when supplemental context is unavailable — plus a transient
// warning toast on a `missing` launch. TUIs with no applicable hook hide it.
function wireMandate(): void {
  const badge = document.querySelector<HTMLElement>('#mandate-warn')
  const toast = document.querySelector<HTMLElement>('.mandate-toast')
  if (!badge || !toast) return
  let hideTimer: number | undefined
  window.aico.context.onMandate(({ slug, state, detail, applicable }) => {
    // No mandate mechanism for this TUI (bare shell etc.) → no badge to show.
    if (!applicable) {
      badge.hidden = true
      toast.classList.remove('show')
      return
    }
    const missing = state === 'missing'
    // Persistent status badge: green tick = adapter verified, red warning =
    // native model running without supplemental Agent Hub context. The tooltip
    // carries full status + detail in both states.
    badge.hidden = false
    badge.classList.toggle('ctx-missing', missing)
    badge.classList.toggle('ctx-ok', !missing)
    badge.textContent = missing ? '⚠' : '✓' // ⚠ / ✓
    badge.title = missing
      ? `${slug}: supplemental Agent Hub context unavailable; native model continues — ${detail}`
      : `${slug}: Agent Hub context adapter verified — ${detail}`
    badge.setAttribute(
      'aria-label',
      missing
        ? `${slug}: native model active without supplemental Agent Hub context`
        : `${slug}: Agent Hub context adapter verified`,
    )
    if (!missing) {
      toast.classList.remove('show')
      return
    }
    // Transient launch toast. textContent (never innerHTML) — detail is built by
    // main but kept plain-text to match the untrusted-toast discipline above.
    toast.textContent = `⚠ ${slug}: native model started without supplemental Agent Hub context`
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

// Push-to-talk dictation (mic -> optional STT websocket -> this widget's prompt). Async
// (resolves the WS URL from main); fire-and-forget so it never blocks the term.
void wireVoice()

// Control surface: lantern menu, pinned cluster, command palette. Independent of
// the terminal; the palette/menu hand focus back here on close (see below).
void initControlSurface()

// The selected font must be loaded before xterm measures its glyph cell, or the
// live view renders at fallback metrics and misaligns once the webfont swaps in.
async function loadTerminalFont(settings: AicoTerminalFontSettings): Promise<void> {
  await document.fonts.load(`${settings.fontSize}px ${fontLoadFaceFor(settings.fontId)}`)
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

// Scroll-back overlay: wheel-up on the live terminal opens a read-only xterm
// view of tmux history. It stays on the same xterm/WebGL renderer path as the
// live terminal and loads bounded pages on demand so wheel-up does not capture
// and write the entire tmux history.
const overlay = new ScrollbackOverlay(
  {
    theme,
    fontFamily,
    fontSize,
    capturePage: (request) => window.aico.scrollback.page(request),
    writeClipboard: (text) => window.aico.clipboard.write(text),
    onDismiss: () => term.focus(),
  },
  host,
)

// Renderer -> PTY keystrokes; PTY -> renderer output. PTY output also drives the
// "thinking" halo heuristic: pulse while output flows, settle ~0.5s after it
// stops. Phase 1's adapter detectIdle() replaces this with real agent state.
let thinking = false
let thinkTimer: number | undefined
function setThinking(on: boolean): void {
  if (on !== thinking) {
    thinking = on
    document.body.classList.toggle('thinking', on) // breathing halo
    window.aico.win.setThinking(on) // amber tray icon while active
  }
}
function pokeThinking(): void {
  setThinking(true)
  if (thinkTimer) clearTimeout(thinkTimer)
  thinkTimer = window.setTimeout(() => setThinking(false), 500)
}

term.onData((data) => window.aico.pty.input(data))
window.aico.pty.onData((data) => {
  term.write(data)
  pokeThinking()
})

// (Re)attach the tmux session for this window at the current viewport size.
// On a renderer reload this fires again and re-attaches the same session.
window.aico.pty.start({ cols: term.cols, rows: term.rows })
terminalLayoutReady = true
scheduleTerminalLayoutFit()

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
  overlay.updateFont(fontFamily, fontSize)
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

async function pasteFromClipboard(): Promise<void> {
  const text = await window.aico.clipboard.read()
  if (text) term.paste(text)
}

host.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  void pasteFromClipboard()
})

term.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) {
    return true
  }
  if (event.code === 'KeyV') {
    void pasteFromClipboard()
    return false
  }
  if (event.code === 'KeyC') {
    const selection = term.getSelection()
    if (selection) window.aico.clipboard.write(selection)
    return false
  }
  return true
})

// The palette/menu hand focus back to the terminal when they close.
window.addEventListener('aico:refocus', () => term.focus())

setupMouseShim(term, host)

window.aico.settings.onTerminalFontChanged((settings) => {
  void applyTerminalFontSettings(settings)
})

host.addEventListener(
  'wheel',
  (e) => {
    const action = scrollbackWheelAction({
      deltaY: e.deltaY,
      overlayActive: overlay.active,
      mouseReportingActive: mouseReportingActive(term),
      tuiSlug,
    })
    if (action === 'ignore') {
      return
    }

    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (action === 'consume') return

    void overlay.enter(wheelLineDelta(e.deltaY))
  },
  { passive: false, capture: true },
)
