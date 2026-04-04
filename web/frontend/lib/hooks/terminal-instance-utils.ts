import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { isMobileDevice } from '../utils/device'
import { applyMobileTerminalTouchStyles } from '../utils/mobile-terminal-touch'

// ---------------------------------------------------------------------------
// Dynamic xterm module loading
// ---------------------------------------------------------------------------

export interface XtermModules {
  Terminal: typeof Terminal
  FitAddon: typeof FitAddon
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon
  ClipboardAddon: typeof import('@xterm/addon-clipboard').ClipboardAddon
}

export async function loadXtermModules(): Promise<XtermModules> {
  const [xtermModule, fitModule, webLinksModule, clipboardModule] =
    await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-clipboard'),
    ])
  return {
    Terminal: xtermModule.Terminal,
    FitAddon: fitModule.FitAddon,
    WebLinksAddon: webLinksModule.WebLinksAddon,
    ClipboardAddon: clipboardModule.ClipboardAddon,
  }
}

// ---------------------------------------------------------------------------
// Terminal creation with addons
// ---------------------------------------------------------------------------

export function createTerminalWithAddons(
  modules: XtermModules,
  opts: TerminalInstanceOptions,
): {
  term: InstanceType<typeof Terminal>
  fitAddon: InstanceType<typeof FitAddon>
} {
  const term = new modules.Terminal({
    cursorBlink: opts.cursorBlink,
    cursorStyle: opts.cursorStyle,
    fontSize: opts.fontSize,
    fontFamily: opts.fontFamily,
    scrollback: opts.scrollback,
    allowProposedApi: true,
    rightClickSelectsWord: true,
    macOptionClickForcesSelection: true,
    altClickMovesCursor: false,
    theme: opts.theme,
  })

  const fitAddon = new modules.FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new modules.WebLinksAddon())
  term.loadAddon(new modules.ClipboardAddon())

  return { term, fitAddon }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalInstanceOptions {
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  fontSize: number
  fontFamily: string
  scrollback: number
  theme: {
    background: string
    foreground: string
    cursor: string
    cursorAccent: string
    selectionBackground: string
    selectionForeground?: string
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }
  onData: (data: string) => void
  onPaste: (data: string) => void
  setupScrolling: (container: HTMLElement) => {
    wheelCleanup: () => void
    touchCleanup: () => void
  }
}

export interface TerminalInstanceRefs {
  terminalRef: React.MutableRefObject<InstanceType<typeof Terminal> | null>
  fitAddonRef: React.MutableRefObject<InstanceType<typeof FitAddon> | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  isFocusedRef: React.MutableRefObject<boolean>
}

// ---------------------------------------------------------------------------
// Bootstrap wheel blocker
// ---------------------------------------------------------------------------

export function installBootstrapWheelBlocker(
  container: HTMLElement,
): () => void {
  const blockWheel = (event: WheelEvent) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  container.addEventListener('wheel', blockWheel, {
    passive: false,
    capture: true,
  })

  return () => {
    container.removeEventListener('wheel', blockWheel, {
      capture: true,
    })
  }
}

// ---------------------------------------------------------------------------
// Scrolling handler replacement
// ---------------------------------------------------------------------------

export function replaceScrollingHandlers(
  container: HTMLElement,
  setupScrolling: TerminalInstanceOptions['setupScrolling'],
  currentCleanup: {
    wheelCleanup: () => void
    touchCleanup: () => void
  } | null,
): {
  wheelCleanup: () => void
  touchCleanup: () => void
} {
  if (currentCleanup) {
    currentCleanup.wheelCleanup()
    currentCleanup.touchCleanup()
  }

  return setupScrolling(container)
}

// ---------------------------------------------------------------------------
// Scrollbar auto-hide setup
// ---------------------------------------------------------------------------

export function setupScrollbarAutoHide(
  container: HTMLElement,
): (() => void) | null {
  const viewport =
    container.querySelector<HTMLElement>('.xterm-viewport')
  let scrollTimer: ReturnType<typeof setTimeout> | null = null

  if (!viewport || isMobileDevice()) return null

  const onScroll = () => {
    viewport.classList.add('scrolling')
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      viewport.classList.remove('scrolling')
    }, 1500)
  }
  viewport.addEventListener('scroll', onScroll, { passive: true })

  return () => {
    viewport.removeEventListener('scroll', onScroll)
    if (scrollTimer) clearTimeout(scrollTimer)
    viewport.classList.remove('scrolling')
  }
}

// ---------------------------------------------------------------------------
// Mobile terminal setup
// ---------------------------------------------------------------------------

export function setupMobileTerminal(container: HTMLElement): void {
  if (!isMobileDevice()) return

  const textarea =
    container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  if (textarea) {
    textarea.inputMode = 'none'
    textarea.readOnly = true
  }

  applyMobileTerminalTouchStyles(container)
}

// ---------------------------------------------------------------------------
// Focus & paste tracking setup
// ---------------------------------------------------------------------------

export interface FocusPasteCleanup {
  focusCleanup: () => void
  pasteCleanup: () => void
}

// ---------------------------------------------------------------------------
// Mobile context-menu paste
// ---------------------------------------------------------------------------

/**
 * On mobile, `touch-action: none` (required for JS-controlled scrolling)
 * suppresses the native long-press context menu that provides "Paste".
 * This handler intercepts the `contextmenu` event on the terminal container
 * and reads from the Clipboard API instead, feeding the result through the
 * same paste path used by desktop Ctrl-V.
 */
export function setupMobileContextMenuPaste(
  container: HTMLElement,
  onPaste: (data: string) => void,
): () => void {
  if (!isMobileDevice()) return () => {}

  const handleContextMenu = (event: MouseEvent) => {
    // Only intercept when the clipboard API is available
    if (!navigator.clipboard?.readText) return

    event.preventDefault()

    navigator.clipboard.readText().then(
      (text) => {
        if (text) onPaste(text)
      },
      () => {
        // Permission denied or clipboard empty — nothing to do
      },
    )
  }

  container.addEventListener('contextmenu', handleContextMenu)

  return () => {
    container.removeEventListener('contextmenu', handleContextMenu)
  }
}

// ---------------------------------------------------------------------------
// Focus & paste tracking setup
// ---------------------------------------------------------------------------

export function setupFocusAndPasteTracking(
  textarea: HTMLTextAreaElement,
  isFocusedRef: React.MutableRefObject<boolean>,
  onPaste: (data: string) => void,
): FocusPasteCleanup {
  const handleFocus = () => {
    isFocusedRef.current = true
  }
  const handleBlur = () => {
    isFocusedRef.current = false
  }
  const handlePaste = (event: ClipboardEvent) => {
    const pastedText = event.clipboardData?.getData('text')
    if (!pastedText) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onPaste(pastedText)
  }

  textarea.addEventListener('focus', handleFocus)
  textarea.addEventListener('blur', handleBlur)
  textarea.addEventListener('paste', handlePaste, true)

  return {
    focusCleanup: () => {
      textarea.removeEventListener('focus', handleFocus)
      textarea.removeEventListener('blur', handleBlur)
    },
    pasteCleanup: () => {
      textarea.removeEventListener('paste', handlePaste, true)
    },
  }
}
