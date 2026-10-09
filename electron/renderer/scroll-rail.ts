import { lineForFraction, railThumb } from './history-window'

// A slim scrollbar drawn inside #terminal's right padding, so it costs the
// terminal no columns. It shows where the view sits in the whole tmux history
// (not just the overlay's loaded window) and seeks through it on drag.

export interface RailPosition {
  /** Absolute top line of the visible rows. */
  topLine: number
  rows: number
  totalLines: number
}

export class ScrollRail {
  private readonly track: HTMLElement
  private readonly thumb: HTMLElement
  private position: RailPosition | null = null
  private dragOffsetPx = 0
  private dragging = false

  constructor(
    mount: HTMLElement,
    /** Seek so this absolute line is at the top of the view. */
    private readonly onSeek: (topLine: number) => void,
  ) {
    this.track = document.createElement('div')
    this.track.className = 'scroll-rail'
    this.track.hidden = true
    this.track.setAttribute('aria-hidden', 'true')
    this.thumb = document.createElement('div')
    this.thumb.className = 'scroll-rail-thumb'
    this.track.appendChild(this.thumb)
    mount.appendChild(this.track)
    this.track.addEventListener('mousedown', this.onMouseDown)
  }

  /** Show `position`, or hide the rail when there is no history to show. */
  update(position: RailPosition | null): void {
    this.position = position
    this.track.hidden = !position || position.totalLines <= position.rows
    if (this.track.hidden || !position) return
    const thumb = railThumb(
      position.topLine,
      position.rows,
      position.totalLines,
      this.track.clientHeight,
    )
    if (!thumb) return
    this.thumb.style.transform = `translateY(${thumb.offsetPx}px)`
    this.thumb.style.height = `${thumb.sizePx}px`
  }

  private seekToPointer(clientY: number): void {
    const position = this.position
    if (!position) return
    const rect = this.track.getBoundingClientRect()
    const thumbPx = this.thumb.getBoundingClientRect().height
    const travel = Math.max(1, rect.height - thumbPx)
    const fraction = (clientY - rect.top - this.dragOffsetPx) / travel
    this.onSeek(lineForFraction(fraction, position.totalLines, position.rows))
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0 || !this.position) return
    e.preventDefault()
    e.stopPropagation()
    const thumbRect = this.thumb.getBoundingClientRect()
    // Grabbing the thumb keeps its grip point; a track click centres it.
    this.dragOffsetPx =
      e.clientY >= thumbRect.top && e.clientY <= thumbRect.bottom
        ? e.clientY - thumbRect.top
        : thumbRect.height / 2
    this.dragging = true
    this.track.classList.add('dragging')
    this.seekToPointer(e.clientY)
    window.addEventListener('mousemove', this.onMouseMove, true)
    window.addEventListener('mouseup', this.onMouseUp, true)
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return
    e.preventDefault()
    e.stopPropagation()
    this.seekToPointer(e.clientY)
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.dragging) return
    e.preventDefault()
    e.stopPropagation()
    this.dragging = false
    this.track.classList.remove('dragging')
    window.removeEventListener('mousemove', this.onMouseMove, true)
    window.removeEventListener('mouseup', this.onMouseUp, true)
  }
}
