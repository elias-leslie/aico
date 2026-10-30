import {
  AICO_TOAST_EVENT,
  type AicoToastDetail,
  setCoordinatorAction,
  setGameActions,
} from './actions'
import { GAMES } from './arcade/games'
import { type ArcadeWiring, wireArcade } from './arcade/wire'
import { initControlSurface } from './control-surface'
import { Eyes } from './eyes'

// The window frame every session window shares, a terminal or a chat: controls,
// the eyes and titlebar games, the session name and coordinator chip, the
// status toast, the context badge, and the lantern menu and palette. It wires
// itself when imported and knows nothing of what fills the window below the
// titlebar.

/** The TUI slug main last named for this window (`shell` until it does). */
export let tuiSlug = 'shell'

// Window chrome: controls and focus state. Independent of the
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

  // Edge resize is the compositor's: Chromium's frameless windows resize from
  // the window edge natively on Wayland and X11 (no handles of our own).
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
export const eyes = wireEyes()

// The titlebar arcade (see arcade/wire.ts): a game per window, on unless
// turned off for every window; the engine loads only while the games are on.
export let arcade: ArcadeWiring | null = null
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

// A session on another host names that host in the titlebar.
function showHostChip(host: string | null): void {
  const el = document.querySelector<HTMLElement>('#host-chip')
  if (!el) return
  el.hidden = !host
  el.textContent = host ?? ''
  el.title = host ? `Runs on ${host}` : ''
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
    showHostChip(info.host)
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
    snip.textContent = snippet // textContent, never innerHTML (untrusted)
    currentAction = action
    toast.classList.toggle('actionable', Boolean(action))
    actionButton.hidden = !action
    dismissButton.hidden = !action
    actionButton.textContent = action?.kind === 'copy' ? 'Copy' : 'Open'
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

  // A delivered selection shows as a short snippet; a handoff in full. The
  // window's own notices (AICO_TOAST_EVENT) are short already and show whole.
  window.aico.selection.onToast((sel) =>
    show(sel.action ? sel : { ...sel, snippet: sel.snippet.slice(0, 40) }),
  )
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
