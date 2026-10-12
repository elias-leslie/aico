import { isMobileDevice } from '../utils/device'
import { forwardClipboardPaste } from './a-term-instance-utils'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

/**
 * Native touch selection for the terminal on phones.
 *
 * xterm draws to a canvas, so Android has no text to long-press: no word
 * selection, no handles, no Copy/Paste bar. While a finger is down, this puts
 * a transparent copy of the visible rows over the canvas, cell-aligned, as a
 * keyboard-less contenteditable. A long-press then lands on real text and the
 * browser does everything itself: selects the word, shows handles, and shows
 * its Cut/Copy/Paste/Select all bar. Copy writes the terminal text (wrapped
 * rows rejoined) and Paste goes through the normal paste path.
 *
 * Taps and drags never see the layer: it is removed on touchend unless a
 * long-press made a selection, and the scroll handlers skip touches while a
 * selection is active (see `isNativeSelectionActive`).
 */

export const NATIVE_SELECTION_LAYER_CLASS = 'a-term-native-selection'
const FROZEN_CLASS = 'is-frozen'
const ACTIVE_ATTRIBUTE = 'data-native-selection'

export function isNativeSelectionActive(container: HTMLElement): boolean {
  return container.hasAttribute(ACTIVE_ATTRIBUTE)
}

export interface MobileNativeSelectionOptions {
  onPaste: (data: string) => void
  onFilePaste?: (file: File) => void
}

/**
 * Text of `range` within the layer rows, joining soft-wrapped rows without a
 * newline so copied commands and paths come out the way they were printed.
 */
export function getLayerSelectionText(
  layer: HTMLElement,
  range: Range,
): string {
  const parts: string[] = []
  for (const row of Array.from(layer.children) as HTMLElement[]) {
    const text = row.firstChild
    if (!(text instanceof Text) || !range.intersectsNode(text)) continue
    const length = text.data.length
    const start =
      range.startContainer === text
        ? range.startOffset
        : range.comparePoint(text, 0) >= 0
          ? 0
          : length
    const end =
      range.endContainer === text
        ? range.endOffset
        : range.comparePoint(text, length) <= 0
          ? length
          : 0
    const piece = text.data.slice(start, Math.max(start, end))
    if (parts.length > 0 && row.dataset.wrapped !== '1') parts.push('\n')
    parts.push(piece)
  }
  return parts.join('')
}

export function setupMobileNativeSelection(
  term: XtermATerm,
  container: HTMLElement,
  options: MobileNativeSelectionOptions,
): () => void {
  if (!isMobileDevice()) return () => {}
  const screen = container.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return () => {}

  const layer = document.createElement('div')
  layer.className = NATIVE_SELECTION_LAYER_CLASS
  layer.setAttribute('aria-hidden', 'true')
  layer.setAttribute('inputmode', 'none')
  layer.setAttribute('autocapitalize', 'off')
  layer.setAttribute('autocorrect', 'off')
  layer.spellcheck = false
  layer.contentEditable = 'false'
  screen.appendChild(layer)

  let armed = false
  let selecting = false

  const renderRows = () => {
    const cols = Math.max(term.cols, 1)
    const rows = Math.max(term.rows, 1)
    const cellWidth = screen.clientWidth / cols
    const cellHeight = screen.clientHeight / rows
    const theme = term.options.theme ?? {}

    layer.style.fontFamily = term.options.fontFamily ?? 'monospace'
    layer.style.fontSize = `${term.options.fontSize ?? 14}px`
    layer.style.setProperty('--a-term-cell-height', `${cellHeight}px`)
    layer.style.setProperty('--a-term-bg', theme.background ?? '#000')
    layer.style.setProperty('--a-term-fg', theme.foreground ?? '#fff')
    layer.style.letterSpacing = '0px'

    // Stretch the font's advance to the canvas cell so long rows stay
    // aligned with what is drawn underneath.
    const probe = document.createElement('span')
    probe.textContent = 'W'.repeat(64)
    layer.replaceChildren(probe)
    const glyphWidth = probe.getBoundingClientRect().width / 64
    if (glyphWidth > 0) {
      layer.style.letterSpacing = `${cellWidth - glyphWidth}px`
    }

    const buffer = term.buffer.active
    const fragment = document.createDocumentFragment()
    for (let y = 0; y < rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y)
      const row = document.createElement('div')
      if (line?.isWrapped) row.dataset.wrapped = '1'
      row.appendChild(
        document.createTextNode(line?.translateToString(true) ?? ''),
      )
      fragment.appendChild(row)
    }
    layer.replaceChildren(fragment)
  }

  const arm = () => {
    renderRows()
    layer.contentEditable = 'true'
    layer.classList.remove(FROZEN_CLASS)
    layer.style.display = 'block'
    armed = true
  }

  // Rows stay in the DOM while hidden: a touch that began on a row keeps
  // that row as its target, and its touchmove/touchend only reach the scroll
  // handlers if the row is still attached. The next arm replaces them.
  const disarm = () => {
    armed = false
    layer.style.display = 'none'
    layer.contentEditable = 'false'
    layer.classList.remove(FROZEN_CLASS)
  }

  const startSelecting = () => {
    if (selecting) return
    selecting = true
    container.setAttribute(ACTIVE_ATTRIBUTE, 'active')
    // A long-press can also reach xterm as a right-click; keep one selection.
    term.clearSelection()
  }

  const dismiss = (refocus = true) => {
    const wasSelecting = selecting
    selecting = false
    container.removeAttribute(ACTIVE_ATTRIBUTE)
    const selection = document.getSelection()
    if (selection?.anchorNode && layer.contains(selection.anchorNode)) {
      selection.removeAllRanges()
    }
    if (document.activeElement === layer) layer.blur()
    disarm()
    // The layer took focus from xterm's textarea; terminal input is gated on
    // that focus, so hand it back.
    if (wasSelecting && refocus) term.focus()
  }

  // --- touch lifecycle -----------------------------------------------------

  const handleTouchStart = (event: TouchEvent) => {
    // Any page touch while selecting means "done": a tap elsewhere or a
    // scroll. The browser's own handles and action bar don't send page touches.
    // Don't re-arm on this touch; it started on a row that must stay attached.
    if (selecting) {
      dismiss()
      return
    }
    if (event.touches.length !== 1) {
      if (armed) disarm()
      return
    }
    arm()
  }

  const handleTouchEnd = (event: TouchEvent) => {
    if (event.touches.length > 0 || selecting || !armed) return
    // A long-press focuses the layer and selects synchronously, before the
    // finger lifts; selectionchange only arrives later as a task.
    if (document.activeElement === layer || hasLayerSelection()) {
      startSelecting()
      return
    }
    // Remove it now so the tap that follows reaches xterm as before.
    disarm()
  }

  // --- browser selection -----------------------------------------------------

  const handleContextMenu = (event: MouseEvent) => {
    // Leave the default alone so Android shows its selection bar, but keep
    // xterm's right-click word selection and any outer handlers out of it.
    event.stopPropagation()
    if (armed) startSelecting()
  }

  const hasLayerSelection = () => {
    const selection = document.getSelection()
    return !!selection?.anchorNode && layer.contains(selection.anchorNode)
  }

  const handleSelectionChange = () => {
    if (armed && hasLayerSelection()) startSelecting()
  }

  const handleFocusOut = (event: FocusEvent) => {
    // Focus moved to another control (keyboard bar, another pane): leave it.
    if (selecting) dismiss(event.relatedTarget === null)
  }

  // --- clipboard -------------------------------------------------------------

  const writeSelection = (event: ClipboardEvent): boolean => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0 || !event.clipboardData) {
      return false
    }
    const text = getLayerSelectionText(layer, selection.getRangeAt(0))
    if (!text) return false
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    return true
  }

  const handleCopy = (event: ClipboardEvent) => {
    event.stopPropagation()
    writeSelection(event)
    // Phones clear the selection after Copy; let the copy finish first.
    window.setTimeout(() => dismiss(), 0)
  }

  const handleCut = (event: ClipboardEvent) => {
    event.stopPropagation()
    // Terminal output can't be cut; copy it and leave it in place.
    if (!writeSelection(event)) event.preventDefault()
    window.setTimeout(() => dismiss(), 0)
  }

  const handlePaste = (event: ClipboardEvent) => {
    // xterm also listens for paste on its root; stop here so it runs once.
    event.stopPropagation()
    if (!forwardClipboardPaste(event, options.onPaste, options.onFilePaste)) {
      event.preventDefault()
    }
    dismiss()
  }

  const blockEditing = (event: Event) => {
    event.preventDefault()
  }

  // --- terminal changes while selecting -------------------------------------

  // Output keeps arriving under a selection. Show the captured rows on the
  // terminal background instead of letting the selection drift off its text.
  const freeze = () => {
    if (selecting) layer.classList.add(FROZEN_CLASS)
  }
  const disposables = [
    term.onWriteParsed(freeze),
    term.onScroll(freeze),
    term.onResize(() => {
      if (selecting || armed) dismiss()
    }),
  ]

  const listenerOptions = { capture: true, passive: true } as const
  container.addEventListener('touchstart', handleTouchStart, listenerOptions)
  container.addEventListener('touchend', handleTouchEnd, listenerOptions)
  container.addEventListener('touchcancel', handleTouchEnd, listenerOptions)
  layer.addEventListener('contextmenu', handleContextMenu)
  layer.addEventListener('focusout', handleFocusOut)
  layer.addEventListener('copy', handleCopy)
  layer.addEventListener('cut', handleCut)
  layer.addEventListener('paste', handlePaste)
  layer.addEventListener('beforeinput', blockEditing)
  layer.addEventListener('drop', blockEditing)
  document.addEventListener('selectionchange', handleSelectionChange)

  return () => {
    for (const disposable of disposables) disposable.dispose()
    container.removeEventListener('touchstart', handleTouchStart, {
      capture: true,
    })
    container.removeEventListener('touchend', handleTouchEnd, { capture: true })
    container.removeEventListener('touchcancel', handleTouchEnd, {
      capture: true,
    })
    document.removeEventListener('selectionchange', handleSelectionChange)
    container.removeAttribute(ACTIVE_ATTRIBUTE)
    layer.remove()
  }
}
