import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { ScrollbackPage } from '../types'
import { wheelLineDelta } from './wheel'

// An attached tmux client drives xterm's alternate screen, which has no
// scrollback. So "scroll back" is a separate, read-only xterm overlaid on top
// of the live terminal and filled with tmux's captured history. The overlay is
// still xterm/WebGL; the performance fix is that scrollback is prefetched and
// fetched in bounded pages instead of capturing all history on the wheel event.

const PAGE_LINES = 5000

interface OverlayDeps {
  /** Visual parity with the live terminal. */
  theme: { background: string; foreground: string }
  fontFamily: string
  fontSize: number
  /** Returns a bounded tmux scrollback page (with color escapes). */
  capturePage: (request?: { fromLine?: number; count?: number }) => Promise<ScrollbackPage>
  /** Copy selected text to the system clipboard. */
  writeClipboard: (text: string) => void
  /** Called when the overlay closes, so the caller can refocus the live term. */
  onDismiss: () => void
}

/** tmux capture-pane pads to the screen height; drop trailing blank lines. */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/[ \t]*\r?\n(\s*\r?\n)*\s*$/, '')
}

function splitCaptureLines(text: string): string[] {
  const withoutFinalNewline = text.replace(/\r?\n$/, '')
  return withoutFinalNewline ? withoutFinalNewline.split(/\r?\n/) : []
}

function tailPageLines(page: ScrollbackPage): string[] {
  const trimmed = trimTrailingBlankLines(page.text)
  return trimmed ? trimmed.split(/\r?\n/) : []
}

function olderPageLines(page: ScrollbackPage): string[] {
  return splitCaptureLines(page.text)
}

function writeText(lines: string[]): string {
  return lines.join('\r\n')
}

function refreshViewport(term: Terminal): void {
  const start = 0
  const end = Math.max(term.rows - 1, 0)
  const renderService = (
    term as Terminal & {
      _core?: { _renderService?: { refreshRows?: (start: number, end: number) => void } }
    }
  )._core?._renderService

  if (typeof renderService?.refreshRows === 'function') {
    renderService.refreshRows(start, end)
    return
  }
  term.refresh(start, end)
}

export class ScrollbackOverlay {
  private readonly host: HTMLElement
  private term: Terminal | null = null
  private fit: FitAddon | null = null
  private entering = false
  private prefetching: Promise<void> | null = null
  private loadingOlder = false
  private lines: string[] = []
  private fromLine = 0
  private totalLines = 0
  active = false

  constructor(
    private readonly deps: OverlayDeps,
    /** The #terminal element - overlay mounts inside it so the chrome's
     *  border/titlebar stay visible and #terminal's radius+overflow clip it. */
    mount: HTMLElement,
  ) {
    this.host = document.createElement('div')
    this.host.id = 'scrollback-overlay'
    Object.assign(this.host.style, {
      position: 'absolute',
      // Match #terminal's padding (6px 8px) so the overlay's xterm aligns with
      // the live xterm, which renders inside that padding. inset:0 would put the
      // overlay 8px left of the live content. Keep the overlay at the normal
      // terminal inset: xterm's FitAddon already subtracts its own 14px
      // scrollbar rail when scrollback is enabled. The live TUI view reserves
      // that same 14px in CSS, matching A-Term's proven geometry.
      inset: '6px 8px',
      display: 'none',
      background: deps.theme.background,
      zIndex: '10', // paint above the live terminal
    })
    mount.appendChild(this.host)
  }

  /** Build the read-only xterm lazily, on first use. */
  private ensureTerm(): Terminal {
    if (this.term) return this.term
    const term = new Terminal({
      fontFamily: this.deps.fontFamily,
      fontSize: this.deps.fontSize,
      theme: this.deps.theme,
      scrollback: 100_000,
      disableStdin: true, // read-only history view
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(this.host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable - DOM renderer is the fallback, still correct.
    }
    fit.fit()

    // Copy the completed selection on mouse release, not on every onSelectionChange
    // tick (which fires per-cell during a drag and would clobber the clipboard with
    // partial selections). The overlay term is built once, so this listener is too.
    this.host.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return
      const sel = term.getSelection()
      if (sel) this.deps.writeClipboard(sel)
    })
    this.host.addEventListener('wheel', this.handleWheel, { passive: false, capture: true })

    this.term = term
    this.fit = fit
    return term
  }

  private applyTailPage(page: ScrollbackPage): boolean {
    const lines = tailPageLines(page)
    if (!lines.length) return false
    this.lines = lines
    this.fromLine = page.fromLine
    this.totalLines = page.totalLines
    return true
  }

  private async captureTailPage(): Promise<boolean> {
    const page = await this.deps.capturePage({ count: PAGE_LINES })
    return this.applyTailPage(page)
  }

  async prefetch(): Promise<void> {
    if (this.active) return
    if (this.prefetching) return this.prefetching

    this.prefetching = this.deps
      .capturePage({ count: PAGE_LINES })
      .then((page) => {
        this.applyTailPage(page)
      })
      .catch((err) => console.warn('[aico] scrollback prefetch failed:', err))
      .finally(() => {
        this.prefetching = null
      })
    return this.prefetching
  }

  private writeOverlay(initialWheelDeltaLines: number, restoreLine?: number): void {
    const term = this.ensureTerm()
    this.active = true
    this.host.style.display = 'block'
    this.fit?.fit()

    term.reset()
    term.write(writeText(this.lines), () => {
      if (!this.active) return
      if (restoreLine !== undefined) {
        term.scrollToLine(restoreLine)
      } else {
        term.scrollToBottom()
        if (initialWheelDeltaLines !== 0) term.scrollLines(initialWheelDeltaLines)
      }
      refreshViewport(term)
    })
  }

  private async loadOlder(): Promise<void> {
    const term = this.term
    if (!term || this.loadingOlder || this.fromLine <= 0) return
    this.loadingOlder = true
    try {
      const count = Math.min(PAGE_LINES, this.fromLine)
      const nextFromLine = this.fromLine - count
      const beforeViewportY = term.buffer.active.viewportY
      const page = await this.deps.capturePage({ fromLine: nextFromLine, count })
      const older = olderPageLines(page)
      if (!older.length) return

      this.lines = [...older, ...this.lines]
      this.fromLine = page.fromLine
      this.totalLines = Math.max(this.totalLines, page.totalLines)
      this.writeOverlay(0, beforeViewportY + older.length)
    } catch (err) {
      console.warn('[aico] scrollback older page failed:', err)
    } finally {
      this.loadingOlder = false
    }
  }

  private handleWheel = (e: WheelEvent) => {
    const term = this.term
    if (!term || e.deltaY === 0) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()

    const buf = term.buffer.active
    const atBottom = buf.viewportY >= buf.baseY
    if (e.deltaY > 0 && atBottom) {
      this.dismiss()
      return
    }

    const atTop = buf.viewportY <= 0
    if (e.deltaY < 0 && atTop && this.fromLine > 0) {
      void this.loadOlder()
      return
    }

    term.scrollLines(wheelLineDelta(e.deltaY))
    refreshViewport(term)
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.dismiss()
    }
  }

  /**
   * Show the overlay from a fresh bounded tail page. A warmed cache is useful
   * for search and future polish, but activation follows A-Term's rule: always
   * ask tmux for the latest page because agent output can make cache stale.
   */
  async enter(initialWheelDeltaLines: number): Promise<void> {
    if (this.active || this.entering) return
    this.entering = true
    try {
      await this.prefetching
      await this.captureTailPage()
      if (!this.lines.length) return

      this.writeOverlay(initialWheelDeltaLines)
      window.addEventListener('keydown', this.onKeydown, true)
    } catch (err) {
      console.warn('[aico] scrollback overlay failed to open:', err)
    } finally {
      this.entering = false
    }
  }

  dismiss(): void {
    if (!this.active) return
    this.active = false
    this.host.style.display = 'none'
    this.term?.clearSelection()
    window.removeEventListener('keydown', this.onKeydown, true)
    this.deps.onDismiss()
  }

  /** Re-fit when the window resizes (only meaningful while visible). */
  fitToWindow(): void {
    if (this.active) this.fit?.fit()
  }

  updateFont(fontFamily: string, fontSize: number): void {
    this.deps.fontFamily = fontFamily
    this.deps.fontSize = fontSize
    if (!this.term) return
    this.term.options.fontFamily = fontFamily
    this.term.options.fontSize = fontSize
    this.fitToWindow()
  }
}
