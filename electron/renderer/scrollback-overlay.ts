import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { ScrollbackPage, ScrollbackPageRequest } from '../types'
import {
  appendWindow,
  type HistoryPoint,
  orderPoints,
  pageStartFor,
  prependWindow,
  selectedText,
  wordBounds,
} from './history-window'
import type { RailPosition } from './scroll-rail'
import { wheelLineDelta } from './wheel'

// An attached tmux client drives xterm's alternate screen, which has no
// scrollback. So "scroll back" is a separate, read-only xterm overlaid on top
// of the live terminal and filled with tmux's captured history.
//
// The overlay holds a bounded window of that history (WINDOW_LINES) and pages
// older or newer lines in as the view nears either end, so reaching far back
// costs neither a whole-history capture nor a whole-history xterm buffer.
// Selection is kept in absolute tmux lines rather than xterm's own selection,
// so a drag can keep going while the window pages underneath it.

const PAGE_LINES = 5000
const WINDOW_LINES = 10_000
/** Autoscroll cadence while a drag holds past the top or bottom edge. */
const AUTOSCROLL_MS = 40

interface OverlayDeps {
  /** Visual parity with the live terminal. */
  theme: { background: string; foreground: string }
  fontFamily: string
  fontSize: number
  /** The live terminal's grid; tmux history is wrapped at this width. */
  size: () => { cols: number; rows: number }
  /** Returns a bounded tmux scrollback page (with color escapes). */
  capturePage: (request?: ScrollbackPageRequest) => Promise<ScrollbackPage>
  /** Copy selected text to the system clipboard. */
  writeClipboard: (text: string) => void
  /** Called when the overlay closes, so the caller can refocus the live term. */
  onDismiss: () => void
  /** Where the view sits in the whole history; null once dismissed. */
  onPosition?: (position: RailPosition | null) => void
}

/** tmux capture-pane pads to the screen height; drop trailing blank lines. */
export function trimTrailingBlankLines(text: string): string {
  // Avoid a nested-whitespace regex here. Long tmux histories commonly contain
  // runs of blank screen rows between TUI redraws; the previous expression
  // backtracked exponentially across those runs and pinned the renderer at 100%
  // CPU while the live scrollback prefetch was being applied.
  const trimmed = text.trimEnd()
  return text.indexOf('\n', trimmed.length) === -1 ? text : trimmed
}

function splitCaptureLines(text: string): string[] {
  const withoutFinalNewline = text.replace(/\r?\n$/, '')
  return withoutFinalNewline ? withoutFinalNewline.split(/\r?\n/) : []
}

function tailPageLines(page: ScrollbackPage): string[] {
  const trimmed = trimTrailingBlankLines(page.text)
  return trimmed ? trimmed.split(/\r?\n/) : []
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
  private entering = false
  private loading = false
  private generation = 0
  /** Loaded lines; lines[i] is absolute line fromLine + i. */
  private lines: string[] = []
  private fromLine = 0
  private totalLines = 0
  /** The window reaches the live bottom of the pane. */
  private atTail = false
  private pendingSeek: number | null = null
  private anchor: HistoryPoint | null = null
  private focus: HistoryPoint | null = null
  private selecting = false
  private pointer = { x: 0, y: 0 }
  private autoscrollTimer: number | undefined
  active = false

  get opening(): boolean {
    return this.entering
  }

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
      // Match #terminal's padding (6px 8px) so the overlay's xterm cells sit
      // exactly over the live xterm's; both share one grid size.
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
    const { cols, rows } = this.deps.size()
    const term = new Terminal({
      cols,
      rows,
      fontFamily: this.deps.fontFamily,
      fontSize: this.deps.fontSize,
      theme: this.deps.theme,
      scrollback: WINDOW_LINES,
      disableStdin: true, // read-only history view
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    })
    term.open(this.host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable - DOM renderer is the fallback, still correct.
    }
    term.onScroll(() => this.reportPosition())

    // Selection runs on absolute tmux lines (see the header), so the overlay
    // takes the mouse before xterm's own selection sees it.
    this.host.addEventListener('mousedown', this.onMouseDown, true)
    this.host.addEventListener('wheel', this.handleWheel, { passive: false, capture: true })

    this.term = term
    return term
  }

  private get windowEnd(): number {
    return this.fromLine + this.lines.length
  }

  private topLine(): number {
    return this.fromLine + (this.term?.buffer.active.viewportY ?? 0)
  }

  private reportPosition(): void {
    if (!this.active || !this.term) return
    this.deps.onPosition?.({
      topLine: this.topLine(),
      rows: this.term.rows,
      totalLines: Math.max(this.totalLines, this.windowEnd),
    })
  }

  /** Apply a page as the whole window. */
  private takePage(page: ScrollbackPage, requested: number): boolean {
    const reachesTail = page.fromLine + requested >= page.totalLines
    const lines = reachesTail ? tailPageLines(page) : splitCaptureLines(page.text)
    if (!lines.length) return false
    this.lines = lines
    this.fromLine = page.fromLine
    this.totalLines = page.totalLines
    this.atTail = reachesTail
    return true
  }

  /** Paint the window and put absolute line `topLine` at the top of the view
   * (or the bottom of the window when omitted). */
  private paint(topLine?: number, afterPaint?: () => void): void {
    const generation = this.generation
    const term = this.ensureTerm()
    const { cols, rows } = this.deps.size()
    this.active = true
    this.host.style.display = 'block'
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)

    term.reset()
    term.write(writeText(this.lines), () => {
      if (!this.active || generation !== this.generation) return
      if (topLine === undefined) term.scrollToBottom()
      else term.scrollToLine(Math.max(0, topLine - this.fromLine))
      this.applySelection()
      refreshViewport(term)
      this.reportPosition()
      afterPaint?.()
    })
  }

  private async fetch(request: ScrollbackPageRequest): Promise<ScrollbackPage | null> {
    const generation = this.generation
    const page = await this.deps.capturePage(request)
    return generation === this.generation ? page : null
  }

  private async loadOlder(): Promise<void> {
    if (!this.active || !this.term || this.loading || this.fromLine <= 0) return
    const generation = this.generation
    this.loading = true
    try {
      const count = Math.min(PAGE_LINES, this.fromLine)
      const keepTop = this.topLine()
      const page = await this.fetch({ fromLine: this.fromLine - count, count })
      if (!page || !this.active) return
      const older = splitCaptureLines(page.text)
      if (!older.length) return
      const merged = prependWindow(this.lines, older, WINDOW_LINES)
      this.lines = merged.lines
      if (merged.droppedNewest) this.atTail = false
      this.fromLine = page.fromLine
      this.totalLines = Math.max(this.totalLines, page.totalLines)
      this.paint(keepTop)
    } catch (err) {
      if (generation === this.generation) console.warn('[aico] scrollback older page failed:', err)
    } finally {
      if (generation === this.generation) this.loading = false
    }
  }

  private async loadNewer(): Promise<void> {
    if (!this.active || !this.term || this.loading || this.atTail) return
    const generation = this.generation
    this.loading = true
    try {
      const keepTop = this.topLine()
      const start = this.windowEnd
      const page = await this.fetch({ fromLine: start, count: PAGE_LINES })
      if (!page || !this.active) return
      const reachesTail = page.fromLine + PAGE_LINES >= page.totalLines
      const newer = reachesTail ? tailPageLines(page) : splitCaptureLines(page.text)
      const merged = appendWindow(this.lines, newer, WINDOW_LINES)
      this.lines = merged.lines
      this.fromLine += merged.droppedOldest
      this.totalLines = Math.max(this.totalLines, page.totalLines)
      this.atTail = reachesTail
      this.paint(keepTop)
    } catch (err) {
      if (generation === this.generation) console.warn('[aico] scrollback newer page failed:', err)
    } finally {
      if (generation === this.generation) this.loading = false
    }
  }

  /** Scroll by `delta` lines, paging the window when the view reaches an end. */
  private scrollBy(delta: number): void {
    const term = this.term
    if (!term || delta === 0) return
    const buf = term.buffer.active
    if (delta < 0 && buf.viewportY + delta < 0 && this.fromLine > 0) {
      term.scrollToTop()
      void this.loadOlder()
      return
    }
    if (delta > 0 && buf.viewportY + delta > buf.baseY && !this.atTail) {
      term.scrollToBottom()
      void this.loadNewer()
      return
    }
    term.scrollLines(delta)
    refreshViewport(term)
  }

  private handleWheel = (e: WheelEvent) => {
    const term = this.term
    if (!term || e.deltaY === 0) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()

    const buf = term.buffer.active
    const atBottom = buf.viewportY >= buf.baseY
    if (e.deltaY > 0 && atBottom && this.atTail && !this.selecting) {
      this.dismiss()
      return
    }
    this.scrollBy(wheelLineDelta(e.deltaY))
    if (this.selecting) this.extendToPointer()
  }

  /** Keep a key the overlay handled away from the live terminal, which still
   * holds focus: a leaked Escape interrupts Claude Code or Codex, and in a
   * shell it turns the next keystroke into a readline meta command. */
  private claimKey(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.claimKey(e)
      this.dismiss()
      return
    }
    if (!this.active || !this.term) return
    const page = Math.max(1, this.term.rows - 1)
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      this.claimKey(e)
      this.scrollBy(e.key === 'PageUp' ? -page : page)
    } else if (e.key === 'Home' && e.ctrlKey) {
      this.claimKey(e)
      this.seek(0)
    } else if (e.key === 'End' && e.ctrlKey) {
      this.claimKey(e)
      this.dismiss()
    }
  }

  // ---- selection -------------------------------------------------------

  /** The history point under a client position, clamped into the view. */
  private pointAt(clientX: number, clientY: number): HistoryPoint | null {
    const term = this.term
    const screen = this.host.querySelector<HTMLElement>('.xterm-screen')
    if (!term || !screen) return null
    const rect = screen.getBoundingClientRect()
    const cellW = rect.width / Math.max(term.cols, 1)
    const cellH = rect.height / Math.max(term.rows, 1)
    if (cellW <= 0 || cellH <= 0) return null
    const col = Math.min(term.cols - 1, Math.max(0, Math.floor((clientX - rect.left) / cellW)))
    const row = Math.min(term.rows - 1, Math.max(0, Math.floor((clientY - rect.top) / cellH)))
    const line = Math.min(this.windowEnd - 1, this.topLine() + row)
    return { line: Math.max(this.fromLine, line), col }
  }

  /** Mirror the absolute selection into xterm for whatever part is loaded. */
  private applySelection(): void {
    const term = this.term
    if (!term) return
    if (!this.anchor || !this.focus) {
      term.clearSelection()
      return
    }
    const [a, b] = orderPoints(this.anchor, this.focus)
    const lastLine = this.windowEnd - 1
    if (b.line < this.fromLine || a.line > lastLine) {
      term.clearSelection()
      return
    }
    const startRow = Math.max(a.line, this.fromLine) - this.fromLine
    const startCol = a.line < this.fromLine ? 0 : a.col
    const endRow = Math.min(b.line, lastLine) - this.fromLine
    const endCol = b.line > lastLine ? term.cols - 1 : b.col
    const length = (endRow - startRow) * term.cols + (endCol - startCol + 1)
    if (length > 0) term.select(startCol, startRow, length)
  }

  private extendToPointer(): void {
    const point = this.pointAt(this.pointer.x, this.pointer.y)
    if (!point) return
    this.focus = point
    this.applySelection()
  }

  private beginDrag(anchor: HistoryPoint, clientX: number, clientY: number): void {
    this.anchor = anchor
    this.focus = anchor
    this.selecting = true
    this.pointer = { x: clientX, y: clientY }
    window.addEventListener('mousemove', this.onMouseMove, true)
    window.addEventListener('mouseup', this.onMouseUp, true)
    this.extendToPointer()
    this.updateAutoscroll()
  }

  private endDrag(): void {
    this.selecting = false
    this.stopAutoscroll()
    window.removeEventListener('mousemove', this.onMouseMove, true)
    window.removeEventListener('mouseup', this.onMouseUp, true)
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0 || !this.term) return
    e.preventDefault()
    e.stopPropagation()
    const point = this.pointAt(e.clientX, e.clientY)
    if (!point) return
    if (e.detail >= 2) {
      const text = this.loadedLineText(point.line)
      const [start, end] = e.detail === 2 ? wordBounds(text, point.col) : [0, text.length - 1]
      this.anchor = { line: point.line, col: start }
      this.focus = { line: point.line, col: Math.max(start, end) }
      this.applySelection()
      void this.copySelection()
      return
    }
    if (e.shiftKey && this.anchor) {
      this.beginDrag(this.anchor, e.clientX, e.clientY)
      return
    }
    this.beginDrag(point, e.clientX, e.clientY)
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.selecting) return
    e.preventDefault()
    e.stopPropagation()
    this.pointer = { x: e.clientX, y: e.clientY }
    this.extendToPointer()
    this.updateAutoscroll()
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.selecting || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    this.endDrag()
    const a = this.anchor
    const b = this.focus
    if (!a || !b || (a.line === b.line && a.col === b.col)) {
      this.anchor = null
      this.focus = null
      this.applySelection()
      return
    }
    void this.copySelection()
  }

  /** Lines past the top or bottom edge the pointer is, signed (0 inside). */
  private edgeOverflow(): number {
    const term = this.term
    const screen = this.host.querySelector<HTMLElement>('.xterm-screen')
    if (!term || !screen) return 0
    const rect = screen.getBoundingClientRect()
    const cellH = rect.height / Math.max(term.rows, 1) || 1
    if (this.pointer.y < rect.top) return -Math.ceil((rect.top - this.pointer.y) / cellH)
    if (this.pointer.y >= rect.bottom) return Math.ceil((this.pointer.y - rect.bottom + 1) / cellH)
    return 0
  }

  private updateAutoscroll(): void {
    if (!this.selecting || this.edgeOverflow() === 0) {
      this.stopAutoscroll()
      return
    }
    if (this.autoscrollTimer !== undefined) return
    this.autoscrollTimer = window.setInterval(() => {
      const overflow = this.edgeOverflow()
      if (!this.selecting || overflow === 0) {
        this.stopAutoscroll()
        return
      }
      // Further past the edge scrolls faster, up to a screen per tick.
      const rows = this.term?.rows ?? 1
      const step = Math.sign(overflow) * Math.min(rows, overflow * overflow)
      this.scrollBy(step)
      this.extendToPointer()
    }, AUTOSCROLL_MS)
  }

  private stopAutoscroll(): void {
    if (this.autoscrollTimer === undefined) return
    window.clearInterval(this.autoscrollTimer)
    this.autoscrollTimer = undefined
  }

  private loadedLineText(line: number): string {
    const row = line - this.fromLine
    return this.term?.buffer.active.getLine(row)?.translateToString(true) ?? ''
  }

  private async copySelection(): Promise<void> {
    if (!this.anchor || !this.focus) return
    const [a, b] = orderPoints(this.anchor, this.focus)
    const generation = this.generation
    let lines: string[]
    if (a.line >= this.fromLine && b.line < this.windowEnd) {
      lines = []
      for (let line = a.line; line <= b.line; line += 1) lines.push(this.loadedLineText(line))
    } else {
      // The span reaches past the loaded window: copy it from tmux as text.
      lines = []
      for (let from = a.line; from <= b.line; from += PAGE_LINES) {
        const count = Math.min(PAGE_LINES, b.line - from + 1)
        const page = await this.deps.capturePage({ fromLine: from, count, plain: true })
        if (generation !== this.generation) return
        lines.push(...splitCaptureLines(page.text).slice(0, count))
      }
    }
    const text = selectedText(lines, a, b)
    if (text) this.deps.writeClipboard(text)
  }

  // ---- entry points ----------------------------------------------------

  private async open(
    request: ScrollbackPageRequest & { count: number },
    topLine: number | undefined,
    afterPaint?: (page: ScrollbackPage) => void,
  ): Promise<void> {
    if (this.active || this.entering) return
    const generation = ++this.generation
    this.entering = true
    // Let Escape cancel the capture itself, not only an overlay that finished
    // rendering. A slow tmux page can otherwise leave the user waiting with no
    // way to dismiss the pending entry.
    window.addEventListener('keydown', this.onKeydown, true)
    try {
      const page = await this.deps.capturePage(request)
      if (generation !== this.generation || !this.takePage(page, request.count)) return
      this.anchor = null
      this.focus = null
      this.paint(topLine, afterPaint ? () => afterPaint(page) : undefined)
    } catch (err) {
      if (generation === this.generation)
        console.warn('[aico] scrollback overlay failed to open:', err)
    } finally {
      if (generation === this.generation) {
        this.entering = false
        if (!this.active) window.removeEventListener('keydown', this.onKeydown, true)
      }
    }
  }

  /**
   * Show the overlay from a fresh bounded tail page. Always ask tmux for the
   * latest page because agent output can make cached history stale.
   */
  async enter(initialWheelDeltaLines: number): Promise<void> {
    await this.open({ count: PAGE_LINES }, undefined, () => {
      if (initialWheelDeltaLines === 0 || !this.term) return
      this.term.scrollLines(initialWheelDeltaLines)
      refreshViewport(this.term)
    })
  }

  /**
   * Take over a drag selection that began on the live view and ran off its top
   * edge (or met the wheel). `row`/`col` is where it started on the live
   * screen; tmux reports which absolute line that row is.
   */
  async continueSelection(
    anchor: { row: number; col: number },
    clientX: number,
    clientY: number,
  ): Promise<void> {
    await this.open({ count: PAGE_LINES }, undefined, (page) => {
      const line = Math.min(this.windowEnd - 1, page.historySize + anchor.row)
      this.beginDrag({ line, col: anchor.col }, clientX, clientY)
    })
  }

  /** Put absolute line `topLine` at the top of the view, opening if needed.
   * `totalHint` is the history length the caller last saw, for a cold open. */
  seek(topLine: number, totalHint = 0): void {
    const rows = this.deps.size().rows
    if (!this.active) {
      if (this.entering) return
      const total = Math.max(totalHint, topLine + rows)
      const from = pageStartFor(topLine, total, PAGE_LINES, rows)
      void this.open({ fromLine: from, count: PAGE_LINES }, topLine)
      return
    }
    const term = this.term
    if (!term) return
    if (topLine >= this.fromLine && topLine + rows <= this.windowEnd) {
      term.scrollToLine(topLine - this.fromLine)
      refreshViewport(term)
      return
    }
    if (topLine + rows > this.windowEnd && this.atTail) {
      term.scrollToBottom()
      refreshViewport(term)
      return
    }
    this.pendingSeek = topLine
    if (this.loading) return
    void this.reloadAround()
  }

  /** Replace the window with one centred on the latest pending seek. */
  private async reloadAround(): Promise<void> {
    const generation = this.generation
    this.loading = true
    try {
      while (this.pendingSeek !== null && generation === this.generation) {
        const target = this.pendingSeek
        this.pendingSeek = null
        const rows = this.deps.size().rows
        const from = pageStartFor(target, this.totalLines, PAGE_LINES, rows)
        const page = await this.fetch({ fromLine: from, count: PAGE_LINES })
        if (!page || !this.active) return
        if (this.pendingSeek !== null) continue // superseded mid-flight
        if (this.takePage(page, PAGE_LINES)) this.paint(target)
      }
    } catch (err) {
      if (generation === this.generation) console.warn('[aico] scrollback seek failed:', err)
    } finally {
      if (generation === this.generation) this.loading = false
    }
  }

  dismiss(): void {
    ++this.generation
    this.entering = false
    this.loading = false
    this.pendingSeek = null
    this.endDrag()
    this.anchor = null
    this.focus = null
    window.removeEventListener('keydown', this.onKeydown, true)
    if (!this.active) return
    this.active = false
    this.host.style.display = 'none'
    // Release the window's buffer; the next entry captures afresh anyway.
    this.lines = []
    this.term?.reset()
    this.deps.onPosition?.(null)
    this.deps.onDismiss()
  }

  /** Follow a live-terminal resize. tmux rewraps history at the new width, so
   * a visible window is recaptured around the same place. */
  fitToWindow(): void {
    if (!this.active || !this.term) return
    const { cols, rows } = this.deps.size()
    if (this.term.cols === cols && this.term.rows === rows) return
    const top = this.topLine()
    this.term.resize(cols, rows)
    this.pendingSeek = top
    if (!this.loading) void this.reloadAround()
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
