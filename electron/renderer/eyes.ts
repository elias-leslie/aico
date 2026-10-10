// Aico's eyes: the titlebar mascot. They are the widget's face — focus, work,
// rest and finishing all show here instead of on the window frame. Every motion
// is a short CSS transition fired from a timer; nothing runs a continuous
// animation, so an idle widget paints nothing.

export type Mood = 'idle' | 'busy' | 'happy' | 'surprised' | 'sleepy' | 'asleep'

/** No output and no input for this long: the lids get heavy. */
export const SLEEPY_AFTER_MS = 2 * 60_000
/** ...and for this long: the eyes close and the odd "z" drifts up. */
export const ASLEEP_AFTER_MS = 6 * 60_000
/** Output must keep flowing this long before the eyes start reading it, so a
 * keystroke echo does not count as work. */
export const READ_AFTER_MS = 700
/** A burst at least this long earns a happy squint when it settles. */
export const CELEBRATE_AFTER_MS = 3_000
/** Farthest a pupil travels from the socket centre (px). */
export const GAZE_MAX = 2.6

/** The mood the eyes rest in when nothing transient is playing. */
export function restingMood(reading: boolean, quietMs: number): Mood {
  if (reading) return 'busy'
  if (quietMs >= ASLEEP_AFTER_MS) return 'asleep'
  if (quietMs >= SLEEPY_AFTER_MS) return 'sleepy'
  return 'idle'
}

/** Clamp a look toward (dx, dy) to the socket, keeping its direction. */
export function aimOffset(dx: number, dy: number, max = GAZE_MAX): { x: number; y: number } {
  const d = Math.hypot(dx, dy)
  if (d === 0) return { x: 0, y: 0 }
  const k = Math.min(max, d) / d
  return { x: dx * k, y: dy * k }
}

export interface ReadingGaze {
  x: number
  line: number
}

/** One reading saccade: hop right along a line, then sweep back to the start
 * of the next, a little lower, wrapping after a few lines. */
export function nextReadingGaze(g: ReadingGaze, hop: number, max = GAZE_MAX): ReadingGaze {
  if (g.x + hop <= max) return { x: g.x + hop, line: g.line }
  return { x: -max, line: (g.line + 1) % 3 }
}

const READING_Y = [0.4, 1.1, 1.8]

export class Eyes {
  private readonly eyes: HTMLElement[]
  private readonly calm = window.matchMedia('(prefers-reduced-motion: reduce)')
  private focused = document.hasFocus()
  private hovering = false
  private busySince = 0
  private reading = false
  private lastActivity = Date.now()
  private transient: { mood: Mood; until: number } | null = null
  private gaze: ReadingGaze = { x: -GAZE_MAX, line: 0 }
  private readTimer: number | undefined
  private transientTimer: number | undefined
  private inputTimer: number | undefined
  private lookingDown = false

  constructor(
    private readonly root: HTMLElement,
    private readonly icon: HTMLElement | null,
  ) {
    this.eyes = [...root.querySelectorAll<HTMLElement>('.eye')]
    root.addEventListener('click', this.boop)
    window.setTimeout(() => this.blink(), 1500 + Math.random() * 2500)
    window.setTimeout(() => this.glance(), 2200)
    window.setInterval(() => this.settle(), 15_000)
    window.setTimeout(() => this.snore(), 4000)
    this.settle()
  }

  /** Tint the irises with the TUI's accent so the face matches its mark. */
  setAccent(color: string): void {
    this.root.style.setProperty('--iris', color || 'var(--mist)')
  }

  /** Terminal output started or stopped flowing. */
  setBusy(on: boolean): void {
    const now = Date.now()
    if (on) {
      this.wake()
      if (!this.busySince) this.busySince = now
      else if (!this.reading && now - this.busySince >= READ_AFTER_MS) this.startReading()
      return
    }
    const ran = this.busySince ? now - this.busySince : 0
    this.busySince = 0
    this.lastActivity = now
    this.stopReading()
    if (ran >= CELEBRATE_AFTER_MS) this.play('happy', 1500)
    else this.settle()
  }

  /** The user typed: glance down at the prompt for a moment. */
  noticeInput(): void {
    this.wake()
    // The TUI redraws as you type; the work clock starts when you stop.
    if (this.busySince) this.busySince = Date.now()
    if (this.reading || this.calm.matches) return
    this.lookingDown = true
    this.look(-0.6, GAZE_MAX)
    window.clearTimeout(this.inputTimer)
    this.inputTimer = window.setTimeout(() => {
      this.lookingDown = false
      if (!this.reading) this.look(0, 0)
    }, 1400)
  }

  setFocused(focused: boolean): void {
    const gained = focused && !this.focused
    this.focused = focused
    if (gained) {
      this.wake()
      this.look(0, 0)
      this.play('surprised', 320)
    }
  }

  /** Global cursor (screen px); followed while unfocused or hovered. */
  cursor(screenX: number, screenY: number): void {
    if (this.reading || this.lookingDown) return
    if (this.focused && !this.hovering) return
    this.aimAt(screenX, screenY)
  }

  /** Pointer moving over the titlebar: they watch it even when focused. */
  hover(e: MouseEvent | null): void {
    this.hovering = e !== null
    if (e) this.cursor(e.screenX, e.screenY)
    else if (this.focused && !this.reading) this.look(0, 0)
  }

  private wake(): void {
    const mood = this.mood()
    this.lastActivity = Date.now()
    if (mood === 'asleep' || mood === 'sleepy') this.play('surprised', 380)
  }

  private mood(): Mood {
    if (this.transient && this.transient.until > Date.now()) return this.transient.mood
    return restingMood(this.reading, Date.now() - this.lastActivity)
  }

  private settle(): void {
    const mood = this.mood()
    if (this.root.dataset.mood !== mood) this.root.dataset.mood = mood
  }

  private play(mood: Mood, ms: number): void {
    this.transient = { mood, until: Date.now() + ms }
    this.settle()
    window.clearTimeout(this.transientTimer)
    this.transientTimer = window.setTimeout(() => {
      this.transient = null
      this.settle()
    }, ms)
  }

  private look(x: number, y: number): void {
    for (const eye of this.eyes) {
      eye.style.setProperty('--px', `${x.toFixed(1)}px`)
      eye.style.setProperty('--py', `${y.toFixed(1)}px`)
    }
    // The mark between the eyes turns its head a little with the gaze.
    this.icon?.style.setProperty('--tilt', `${(x * 4).toFixed(1)}deg`)
  }

  private aimAt(screenX: number, screenY: number): void {
    // Both eyes converge on one point, aimed from the face's centre so they
    // never go cross-eyed on a cursor parked between them.
    const r = this.root.getBoundingClientRect()
    const o = aimOffset(
      screenX - (window.screenX + r.left + r.width / 2),
      screenY - (window.screenY + r.top + r.height / 2),
    )
    this.look(o.x, o.y)
  }

  private startReading(): void {
    if (this.reading) return
    this.reading = true
    this.settle()
    if (this.calm.matches) return
    const step = (): void => {
      if (!this.reading) return
      this.gaze = nextReadingGaze(this.gaze, 0.9 + Math.random() * 0.8)
      this.look(this.gaze.x, READING_Y[this.gaze.line] ?? 1)
      // A line return is a longer sweep; word hops are quick.
      const sweep = this.gaze.x === -GAZE_MAX
      this.readTimer = window.setTimeout(step, sweep ? 420 : 230 + Math.random() * 200)
    }
    step()
  }

  private stopReading(): void {
    if (!this.reading) return
    this.reading = false
    window.clearTimeout(this.readTimer)
    this.gaze = { x: -GAZE_MAX, line: 0 }
    this.look(0, 0)
    this.settle()
  }

  private blink(): void {
    const mood = this.mood()
    if (mood !== 'asleep' && mood !== 'happy') {
      this.root.classList.add('blink')
      window.setTimeout(() => this.root.classList.remove('blink'), 110)
      // Now and then a double blink, the way people do.
      if (Math.random() < 0.18) {
        window.setTimeout(() => {
          this.root.classList.add('blink')
          window.setTimeout(() => this.root.classList.remove('blink'), 100)
        }, 230)
      }
    }
    const heavy = mood === 'sleepy' ? 0.6 : 1
    window.setTimeout(() => this.blink(), (2600 + Math.random() * 4400) * heavy)
  }

  /** Idle saccade: while focused and at rest, glance off-centre and back. */
  private glance(): void {
    if (
      this.focused &&
      !this.hovering &&
      !this.reading &&
      !this.lookingDown &&
      !this.calm.matches &&
      this.mood() === 'idle' &&
      Math.random() < 0.5
    ) {
      const a = Math.random() * Math.PI * 2
      const r = 0.8 + Math.random() * (GAZE_MAX - 0.8)
      this.look(Math.cos(a) * r, Math.sin(a) * r)
      window.setTimeout(
        () => {
          if (!this.reading && !this.hovering && !this.lookingDown) this.look(0, 0)
        },
        500 + Math.random() * 800,
      )
    }
    window.setTimeout(() => this.glance(), 1900 + Math.random() * 2700)
  }

  /** While asleep, a small "z" drifts up from the face every few seconds. */
  private snore(): void {
    this.settle()
    if (this.mood() === 'asleep' && !this.calm.matches) {
      this.root.classList.remove('snore')
      void this.root.offsetWidth // restart the one-shot drift
      this.root.classList.add('snore')
    }
    window.setTimeout(() => this.snore(), 4200)
  }

  /** Click the face: a happy squint and a wink — or a startled wake-up. */
  private boop = (): void => {
    const wasAsleep = this.mood() === 'asleep' || this.mood() === 'sleepy'
    this.lastActivity = Date.now()
    if (wasAsleep) {
      this.play('surprised', 500)
      return
    }
    this.play('happy', 900)
    const left = this.eyes[0]
    if (!left) return
    left.classList.add('wink')
    window.setTimeout(() => left.classList.remove('wink'), 260)
  }
}
