import type { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import { isMobileDevice } from '../utils/device'
import { applyMobileATermTouchStyles } from '../utils/mobile-a-term-touch'
import { shouldUseWebglRenderer } from '../utils/renderer-preference'

type XtermATermConstructor = typeof import('@xterm/xterm').Terminal
type XtermATerm = InstanceType<XtermATermConstructor>

// ---------------------------------------------------------------------------
// Dynamic xterm module loading
// ---------------------------------------------------------------------------

export interface XtermModules {
  XtermATerm: XtermATermConstructor
  FitAddon: typeof FitAddon
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon
  ClipboardAddon: typeof import('@xterm/addon-clipboard').ClipboardAddon
  WebglAddon: typeof WebglAddon
}

export interface ATermRendererStatus {
  renderer: 'webgl' | 'dom'
  webglContextAvailable: boolean
  webgl2ContextAvailable: boolean
  webglAddonLoaded: boolean
  canvasCount: number
  termClassName: string
  userAgent: string
}

export async function loadXtermModules(): Promise<XtermModules> {
  const [xtermModule, fitModule, webLinksModule, clipboardModule, webglModule] =
    await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-clipboard'),
      import('@xterm/addon-webgl'),
    ])
  return {
    XtermATerm: xtermModule.Terminal,
    FitAddon: fitModule.FitAddon,
    WebLinksAddon: webLinksModule.WebLinksAddon,
    ClipboardAddon: clipboardModule.ClipboardAddon,
    WebglAddon: webglModule.WebglAddon,
  }
}

/**
 * Load the WebGL renderer after term.open(). Must be called after the canvas
 * is mounted. Returns a cleanup function on success, or null when the renderer
 * is disabled or unavailable (caller stays on the DOM renderer). The addon also
 * self-disposes on context loss so xterm transparently falls back.
 */
export function loadWebglRenderer(
  term: XtermATerm,
  modules: Pick<XtermModules, 'WebglAddon'>,
): (() => void) | null {
  if (!shouldUseWebglRenderer()) return null
  try {
    const addon = new modules.WebglAddon()
    addon.onContextLoss(() => addon.dispose())
    term.loadAddon(addon)
    return () => addon.dispose()
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('WebGL renderer unavailable, falling back to DOM:', error)
    return null
  }
}

export function collectATermRendererStatus(
  term: XtermATerm,
  webglAddonLoaded: boolean,
): ATermRendererStatus {
  const canvas = document.createElement('canvas')
  const webglContextAvailable = !!canvas.getContext('webgl')
  const webgl2ContextAvailable = !!canvas.getContext('webgl2')
  const canvasCount = term.element?.querySelectorAll('canvas').length ?? 0

  return {
    renderer: canvasCount > 0 ? 'webgl' : 'dom',
    webglContextAvailable,
    webgl2ContextAvailable,
    webglAddonLoaded,
    canvasCount,
    termClassName: term.element?.className ?? '',
    userAgent: navigator.userAgent,
  }
}

// ---------------------------------------------------------------------------
// A-Term creation with addons
// ---------------------------------------------------------------------------

export function createATermWithAddons(
  modules: XtermModules,
  opts: ATermInstanceOptions,
): {
  term: XtermATerm
  fitAddon: InstanceType<typeof FitAddon>
} {
  const term = new modules.XtermATerm({
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

export interface ATermInstanceOptions {
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
  onFilePaste?: (file: File) => void
  onRendererStatus?: (status: ATermRendererStatus) => void
  setupScrolling: (container: HTMLElement) => {
    wheelCleanup: () => void
    touchCleanup: () => void
  }
}

export interface ATermInstanceRefs {
  aTermRef: React.MutableRefObject<XtermATerm | null>
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
  setupScrolling: ATermInstanceOptions['setupScrolling'],
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
  const viewport = container.querySelector<HTMLElement>('.xterm-viewport')
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
// Mobile a-term setup
// ---------------------------------------------------------------------------

export function setupMobileATerm(container: HTMLElement): void {
  if (!isMobileDevice()) return

  const textarea = container.querySelector<HTMLTextAreaElement>(
    '.xterm-helper-textarea',
  )
  if (textarea) {
    textarea.inputMode = 'none'
    textarea.readOnly = true
  }

  applyMobileATermTouchStyles(container)
}

// ---------------------------------------------------------------------------
// Focus & paste tracking setup
// ---------------------------------------------------------------------------

export interface FocusPasteCleanup {
  focusCleanup: () => void
  pasteCleanup: () => void
}

function getClipboardImageFile(
  clipboardData: DataTransfer | null,
): File | null {
  if (!clipboardData) return null

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file.type.startsWith('image/')) return file
  }

  return null
}

// ---------------------------------------------------------------------------
// Mobile context-menu paste
// ---------------------------------------------------------------------------

/**
 * On mobile, `touch-action: none` (required for JS-controlled scrolling)
 * suppresses the native long-press context menu that provides "Paste".
 * This handler intercepts the `contextmenu` event on the a-term container
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
  onFilePaste?: (file: File) => void,
): FocusPasteCleanup {
  const handleFocus = () => {
    isFocusedRef.current = true
  }
  const handleBlur = () => {
    isFocusedRef.current = false
  }
  const handlePaste = (event: ClipboardEvent) => {
    const pastedImage = getClipboardImageFile(event.clipboardData)
    if (pastedImage) {
      event.preventDefault()
      event.stopImmediatePropagation()
      onFilePaste?.(pastedImage)
      return
    }

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
