// Aico's eyes: the titlebar mascot. They are the widget's face — focus, work,
// rest and finishing all show here instead of on the window frame. Every motion
// is a short CSS transition fired from a timer; nothing runs a continuous
// animation, so an idle widget paints nothing.

export type Mood = 'idle' | 'busy' | 'happy' | 'surprised' | 'sleepy' | 'asleep' | 'content'

/** What the session needs from the owner, as main's attention.ts sends it. */
export type AttentionMode = 'none' | 'blocked' | 'finished'
export type AttentionStage = 'fresh' | 'rising' | 'urgent'

/** The eye motions that call the owner to a waiting window:
 *   pop     the eyes grow ~3x over the window's corner and hop, then shrink back
 *   wiggle  side to side with raised brows, darting, then a look straight out
 *   nudge   the "?" bubble bounces and the eyes glance up at it */
export type Motion = 'pop' | 'wiggle' | 'nudge'
const MOTIONS: readonly Motion[] = ['pop', 'wiggle', 'nudge']
/** How long each motion plays (ms); keep in step with chrome.css. */
export const MOTION_MS: Record<Motion, number> = { pop: 1900, wiggle: 1900, nudge: 1200 }
/** Once rising, a motion every so often, never on a beat. */
export const MOTION_EVERY_MS: [number, number] = [7_000, 9_000]

/** A different motion from the last, picked at random. */
export function nextMotion(last: Motion | null, rand: () => number): Motion {
  const choices = MOTIONS.filter((m) => m !== last)
  return choices[Math.floor(rand() * choices.length)] ?? 'nudge'
}

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

/** One eye's pupil offset, or null to leave that eye where it is. */
export type Gaze = { x: number; y: number } | null
export interface ExchangeStep {
  at: number
  left: Gaze
  right: Gaze
}

/** Every so often, while at rest, the eyes look at each other — the Brady
 * Bunch grid, two faces long. */
export const EXCHANGE_EVERY_MS: [number, number] = [25_000, 55_000]

/** A little scene of the two eyes noticing each other, then back to you.
 * Pupils lean in toward the partner (left eye looks right, right eye left). */
export function exchangeScene(pick: number): ExchangeStep[] {
  const toRight = { x: GAZE_MAX, y: 0.3 }
  const toLeft = { x: -GAZE_MAX, y: 0.3 }
  const centre = { x: 0, y: 0 }
  if (pick < 0.4) {
    // Left glances over; a beat later the right turns to meet it; both back.
    return [
      { at: 0, left: toRight, right: null },
      { at: 450, left: null, right: toLeft },
      { at: 1500, left: centre, right: centre },
    ]
  }
  if (pick < 0.7) {
    // The mirror: right starts it, left answers.
    return [
      { at: 0, left: null, right: toLeft },
      { at: 450, left: toRight, right: null },
      { at: 1500, left: centre, right: centre },
    ]
  }
  // Both at once, a look back and forth, then caught — straight back to you.
  return [
    { at: 0, left: toRight, right: toLeft },
    { at: 700, left: centre, right: centre },
    { at: 1050, left: toRight, right: toLeft },
    { at: 1700, left: centre, right: centre },
  ]
}

/**
 * Show what the session needs from the owner: data-attention / data-stage on
 * the document (the amber border and tint in chrome.css) and the bubble's
 * "?" or "✓", hidden when nothing is needed. Returns the mood the eyes hold
 * meanwhile (finished: content ^ ^), or null.
 */
export function applyAttention(
  doc: { dataset: DOMStringMap },
  bubble: { textContent: string | null; hidden: boolean } | null,
  mode: AttentionMode,
  stage: AttentionStage,
): Mood | null {
  if (mode === 'none') {
    delete doc.dataset.attention
    delete doc.dataset.stage
  } else {
    doc.dataset.attention = mode
    doc.dataset.stage = stage
  }
  if (bubble) {
    bubble.textContent = mode === 'blocked' ? '?' : mode === 'finished' ? '✓' : ''
    bubble.hidden = mode === 'none'
  }
  return mode === 'finished' ? 'content' : null
}

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
  private exchanging = false
  private peerTurn = 0
  private peerUntil = 0
  /** A mood held while the window waits on the owner (finished: content). */
  private held: Mood | null = null
  private attention: { mode: AttentionMode; stage: AttentionStage } = {
    mode: 'none',
    stage: 'fresh',
  }
  private lastMotion: Motion | null = null
  private motionTimer: number | undefined
  /** A motion owns the gaze until it ends. */
  private performing = false
  private readonly bubble: HTMLElement | null

  constructor(
    private readonly root: HTMLElement,
    private readonly icon: HTMLElement | null,
  ) {
    this.eyes = [...root.querySelectorAll<HTMLElement>('.eye')]
    this.bubble = root.querySelector<HTMLElement>('.bubble')
    root.addEventListener('click', this.boop)
    window.setTimeout(() => this.blink(), 1500 + Math.random() * 2500)
    window.setTimeout(() => this.glance(), 2200)
    window.setInterval(() => this.settle(), 15_000)
    window.setTimeout(() => this.snore(), 4000)
    this.scheduleExchange()
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
    // Focus is the owner looking: everything clears at once, before main says so.
    if (gained) this.setAttention('none', 'fresh')
    if (gained) {
      this.wake()
      this.look(0, 0)
      this.play('surprised', 320)
    }
  }

  /** Global cursor (screen px); followed while unfocused or hovered. */
  cursor(screenX: number, screenY: number): void {
    if (this.reading || this.lookingDown || this.performing) return
    if (this.focused && !this.hovering) return
    this.aimAt(screenX, screenY)
  }

  /** A titlebar character to follow (client px), or null when none moves.
   * Only while focused and otherwise idle: unfocused eyes keep the cursor. */
  watch(pt: { x: number; y: number } | null): void {
    if (!this.focused || this.hovering || this.reading || this.lookingDown || this.performing)
      return
    if (pt) this.aimAt(window.screenX + pt.x, window.screenY + pt.y)
    else this.look(0, 0)
  }

  /** Pointer moving over the titlebar: they watch it even when focused. */
  hover(e: MouseEvent | null): void {
    this.hovering = e !== null
    if (e) this.cursor(e.screenX, e.screenY)
    else if (this.focused && !this.reading) this.look(0, 0)
  }

  /**
   * The session needs the owner (main attention.ts). Blocked: a "?" bubble and
   * one eye motion; from `rising` the border pulses amber, the titlebar is
   * tinted and a motion plays every ~8 s. Finished: a "✓" bubble and content
   * ^ ^ eyes, nothing moving. Reduced motion keeps the bubble, border and tint
   * but no motion; the focused window shows nothing.
   */
  setAttention(mode: AttentionMode, stage: AttentionStage): void {
    if (this.focused && mode !== 'none') return
    const was = this.attention
    this.attention = { mode, stage }
    this.held = applyAttention(document.documentElement, this.bubble, mode, stage)
    this.settle()
    if (mode !== 'blocked') {
      window.clearTimeout(this.motionTimer)
      this.motionTimer = undefined
      this.endMotion()
      return
    }
    if (was.mode !== 'blocked') window.setTimeout(() => this.perform(), 400)
    if (stage !== 'fresh' && this.motionTimer === undefined) this.scheduleMotion()
  }

  private scheduleMotion(): void {
    const [lo, hi] = MOTION_EVERY_MS
    this.motionTimer = window.setTimeout(
      () => {
        this.motionTimer = undefined
        if (this.attention.mode !== 'blocked') return
        this.perform()
        this.scheduleMotion()
      },
      lo + Math.random() * (hi - lo),
    )
  }

  private perform(): void {
    if (this.attention.mode !== 'blocked' || this.focused || this.calm.matches || this.performing)
      return
    const motion = nextMotion(this.lastMotion, Math.random)
    this.lastMotion = motion
    this.performing = true
    this.wake()
    this.root.classList.add(motion)
    if (motion === 'wiggle') {
      // Dart side to side, then a beat looking straight at you, eyes wide.
      this.transient = { mood: 'surprised', until: Date.now() + MOTION_MS.wiggle }
      this.settle()
      const darts = [-GAZE_MAX, GAZE_MAX, -GAZE_MAX, GAZE_MAX, -GAZE_MAX * 0.6]
      darts.forEach((x, i) => {
        window.setTimeout(() => this.performing && this.look(x, 0), i * 170)
      })
      window.setTimeout(() => this.performing && this.look(0, 0), darts.length * 170)
    } else if (motion === 'nudge') {
      this.look(GAZE_MAX * 0.8, -GAZE_MAX * 0.7)
    } else {
      this.look(0, 0)
    }
    window.setTimeout(() => this.endMotion(), MOTION_MS[motion])
  }

  private endMotion(): void {
    for (const m of MOTIONS) this.root.classList.remove(m)
    if (!this.performing) return
    this.performing = false
    this.transient = null
    this.settle()
    this.look(0, 0)
  }

  private wake(): void {
    const mood = this.mood()
    this.lastActivity = Date.now()
    if (mood === 'asleep' || mood === 'sleepy') this.play('surprised', 380)
  }

  private mood(): Mood {
    if (this.transient && this.transient.until > Date.now()) return this.transient.mood
    if (this.held) return this.held
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
    this.exchanging = false
    for (const eye of this.eyes) {
      eye.style.setProperty('--px', `${x.toFixed(1)}px`)
      eye.style.setProperty('--py', `${y.toFixed(1)}px`)
    }
    // The mark between the eyes turns its head a little with the gaze.
    this.icon?.style.setProperty('--tilt', `${(x * 4).toFixed(1)}deg`)
  }

  /** Another Aico window is the one to look at (screen px): turn to it after
   * `delay`, hold, then go back to what they were doing. Even reading eyes
   * glance up from the work; typing, hovered or sleeping eyes stay put. */
  lookAtPeer(screenX: number, screenY: number, delay: number, hold: number): void {
    const turn = ++this.peerTurn
    window.setTimeout(() => {
      if (turn !== this.peerTurn || !this.canGlanceAtPeer()) return
      this.peerUntil = Date.now() + hold
      this.aimAt(screenX, screenY)
      window.setTimeout(() => {
        if (turn !== this.peerTurn) return
        this.peerUntil = 0
        // Reading resumes on its own next saccade.
        if (!this.reading && this.atRest()) this.look(0, 0)
      }, hold)
    }, delay)
  }

  private canGlanceAtPeer(): boolean {
    const mood = this.mood()
    return (
      !this.hovering &&
      !this.lookingDown &&
      !this.calm.matches &&
      (mood === 'idle' || mood === 'sleepy' || mood === 'busy')
    )
  }

  private lookEach(left: Gaze, right: Gaze): void {
    const set = (eye: HTMLElement | undefined, g: Gaze): void => {
      if (!eye || !g) return
      eye.style.setProperty('--px', `${g.x.toFixed(1)}px`)
      eye.style.setProperty('--py', `${g.y.toFixed(1)}px`)
    }
    set(this.eyes[0], left)
    set(this.eyes[1], right)
    this.icon?.style.setProperty('--tilt', '0deg')
  }

  private atRest(): boolean {
    return (
      !this.hovering &&
      !this.reading &&
      !this.lookingDown &&
      !this.calm.matches &&
      (this.mood() === 'idle' || this.mood() === 'sleepy')
    )
  }

  private scheduleExchange(): void {
    const [lo, hi] = EXCHANGE_EVERY_MS
    window.setTimeout(() => this.exchange(), lo + Math.random() * (hi - lo))
  }

  /** The eyes look at each other. Any other gaze (cursor, typing, reading)
   * calls look(), which ends the scene where it stands. */
  private exchange(): void {
    this.scheduleExchange()
    if (!this.focused || !this.atRest() || this.eyes.length < 2) return
    this.exchanging = true
    const scene = exchangeScene(Math.random())
    for (const step of scene) {
      window.setTimeout(() => {
        if (this.exchanging && this.atRest()) this.lookEach(step.left, step.right)
      }, step.at)
    }
    window.setTimeout(
      () => {
        this.exchanging = false
      },
      (scene.at(-1)?.at ?? 0) + 50,
    )
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
      if (Date.now() < this.peerUntil) {
        this.readTimer = window.setTimeout(step, this.peerUntil - Date.now() + 60)
        return
      }
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
    if (mood !== 'asleep' && mood !== 'happy' && mood !== 'content') {
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
      !this.exchanging &&
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
