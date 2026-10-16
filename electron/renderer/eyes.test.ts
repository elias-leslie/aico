import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASLEEP_AFTER_MS,
  aimOffset,
  applyAttention,
  Eyes,
  exchangeScene,
  GAZE_MAX,
  MOTION_EVERY_MS,
  MOTION_MS,
  type Motion,
  nextMotion,
  nextReadingGaze,
  restingMood,
  SLEEPY_AFTER_MS,
} from './eyes'

describe('restingMood', () => {
  it('reads while output flows, however long it has been quiet before', () => {
    expect(restingMood(true, ASLEEP_AFTER_MS * 2)).toBe('busy')
  })

  it('gets sleepy, then falls asleep, as the quiet stretches', () => {
    expect(restingMood(false, 0)).toBe('idle')
    expect(restingMood(false, SLEEPY_AFTER_MS - 1)).toBe('idle')
    expect(restingMood(false, SLEEPY_AFTER_MS)).toBe('sleepy')
    expect(restingMood(false, ASLEEP_AFTER_MS)).toBe('asleep')
  })
})

describe('aimOffset', () => {
  it('keeps a near target as is', () => {
    expect(aimOffset(1, -1)).toEqual({ x: 1, y: -1 })
  })

  it('clamps a far target to the socket edge in the same direction', () => {
    const o = aimOffset(300, 400)
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(GAZE_MAX)
    expect(o.y / o.x).toBeCloseTo(400 / 300)
  })

  it('looks straight ahead at a target on the face', () => {
    expect(aimOffset(0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('nextReadingGaze', () => {
  it('hops right along the line', () => {
    expect(nextReadingGaze({ x: -GAZE_MAX, line: 0 }, 1)).toEqual({ x: -GAZE_MAX + 1, line: 0 })
  })

  it('sweeps back to the start of the next line at the edge, wrapping after three', () => {
    expect(nextReadingGaze({ x: GAZE_MAX - 0.5, line: 0 }, 1)).toEqual({ x: -GAZE_MAX, line: 1 })
    expect(nextReadingGaze({ x: GAZE_MAX, line: 2 }, 1)).toEqual({ x: -GAZE_MAX, line: 0 })
  })
})

describe('exchangeScene', () => {
  it('has the eyes look at each other, then back at you', () => {
    for (const pick of [0, 0.5, 0.9]) {
      const scene = exchangeScene(pick)
      expect(scene.some((s) => (s.left?.x ?? 0) > 0)).toBe(true)
      expect(scene.some((s) => (s.right?.x ?? 0) < 0)).toBe(true)
      const last = scene.at(-1)
      expect(last?.left).toEqual({ x: 0, y: 0 })
      expect(last?.right).toEqual({ x: 0, y: 0 })
      expect(scene.map((s) => s.at)).toEqual([...scene.map((s) => s.at)].sort((a, b) => a - b))
    }
  })
})

describe('nextMotion', () => {
  it('never plays the same motion twice running, and uses all three', () => {
    const seen = new Set<Motion>()
    let last: Motion | null = null
    for (const r of [0, 0.5, 0.99, 0, 0.7, 0.2, 0.9]) {
      const motion = nextMotion(last, () => r)
      expect(motion).not.toBe(last)
      seen.add(motion)
      last = motion
    }
    expect([...seen].sort()).toEqual(['nudge', 'pop', 'wiggle'])
  })
})

describe('applyAttention', () => {
  const fresh = () => ({
    doc: { dataset: {} as DOMStringMap },
    bubble: { textContent: '' as string | null, hidden: true },
  })

  it('a waiting session gets the attention attributes and a "?" bubble', () => {
    const { doc, bubble } = fresh()
    expect(applyAttention(doc, bubble, 'blocked', 'rising')).toBeNull()
    expect(doc.dataset).toEqual({ attention: 'blocked', stage: 'rising' })
    expect(bubble).toEqual({ textContent: '?', hidden: false })
  })

  it('a finished session shows "✓" and holds the eyes content', () => {
    const { doc, bubble } = fresh()
    expect(applyAttention(doc, bubble, 'finished', 'fresh')).toBe('content')
    expect(doc.dataset).toEqual({ attention: 'finished', stage: 'fresh' })
    expect(bubble).toEqual({ textContent: '✓', hidden: false })
  })

  it('nothing needed clears the attributes and hides the bubble', () => {
    const { doc, bubble } = fresh()
    applyAttention(doc, bubble, 'blocked', 'urgent')
    expect(applyAttention(doc, bubble, 'none', 'fresh')).toBeNull()
    expect(doc.dataset).toEqual({})
    expect(bubble).toEqual({ textContent: '', hidden: true })
  })

  it('works without a bubble', () => {
    const { doc } = fresh()
    expect(applyAttention(doc, null, 'finished', 'fresh')).toBe('content')
    expect(doc.dataset.attention).toBe('finished')
  })
})

// ---- the Eyes class on a fake titlebar -------------------------------------------
class FakeEl {
  dataset: Record<string, string> = {}
  props = new Map<string, string>()
  classes = new Set<string>()
  textContent: string | null = ''
  hidden = true
  offsetWidth = 20
  style = { setProperty: (k: string, v: string) => this.props.set(k, v) }
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (...cs: string[]) => {
      for (const c of cs) this.classes.delete(c)
    },
    contains: (c: string) => this.classes.has(c),
  }
  listeners = 0
  addEventListener() {
    this.listeners++
  }
  removeEventListener() {
    this.listeners--
  }
  getBoundingClientRect() {
    return { left: 10, top: 6, width: 30, height: 20, right: 40, bottom: 26 }
  }
}

/** A face as renderer.ts builds it, plus handles on what the owner sees. */
function face(opts: { focused?: boolean; reducedMotion?: boolean } = {}) {
  const root = new FakeEl()
  const eyesEls = [new FakeEl(), new FakeEl()]
  const bubble = new FakeEl()
  const doc = new FakeEl()
  const r = root as unknown as Record<string, unknown>
  r.querySelectorAll = () => eyesEls
  r.querySelector = (sel: string) => (sel === '.bubble' ? bubble : null)
  vi.stubGlobal('document', { hasFocus: () => opts.focused ?? false, documentElement: doc })
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: opts.reducedMotion ?? false }),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id?: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    screenX: 0,
    screenY: 0,
  })
  const eyes = new Eyes(root as unknown as HTMLElement, null)
  const motion = (): Motion | null =>
    (['pop', 'wiggle', 'nudge'] as const).find((m) => root.classes.has(m)) ?? null
  const gaze = () => ({ x: eyesEls[0]?.props.get('--px'), y: eyesEls[0]?.props.get('--py') })
  return { eyes, root, bubble, doc, motion, gaze }
}

describe('Eyes attention', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a waiting window shows the "?" bubble and the attention attributes', () => {
    const f = face()
    f.eyes.setAttention('blocked', 'rising')
    expect(f.doc.dataset).toEqual({ attention: 'blocked', stage: 'rising' })
    expect(f.bubble.textContent).toBe('?')
    expect(f.bubble.hidden).toBe(false)
  })

  it('the focused window ignores attention: the owner is already looking', () => {
    const f = face({ focused: true })
    f.eyes.setAttention('blocked', 'urgent')
    expect(f.doc.dataset).toEqual({})
    expect(f.bubble.hidden).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(f.motion()).toBeNull()
  })

  it('gaining focus clears everything at once, before main says so', () => {
    const f = face()
    f.eyes.setAttention('blocked', 'urgent')
    f.eyes.setFocused(true)
    expect(f.doc.dataset).toEqual({})
    expect(f.bubble.hidden).toBe(true)
    expect(f.bubble.textContent).toBe('')
  })

  it('going back to nothing hides the bubble and stops any motion', () => {
    const f = face()
    f.eyes.setAttention('blocked', 'rising')
    vi.advanceTimersByTime(400)
    expect(f.motion()).not.toBeNull()
    f.eyes.setAttention('none', 'fresh')
    expect(f.bubble.hidden).toBe(true)
    expect(f.doc.dataset).toEqual({})
    expect(f.motion()).toBeNull()
    vi.advanceTimersByTime(30_000)
    expect(f.motion()).toBeNull()
  })

  it('finished holds the eyes content until the attention clears', () => {
    const f = face()
    f.eyes.setAttention('finished', 'fresh')
    expect(f.bubble.textContent).toBe('✓')
    expect(f.root.dataset.mood).toBe('content')
    vi.advanceTimersByTime(20_000)
    expect(f.root.dataset.mood).toBe('content')
    expect(f.motion()).toBeNull()
    f.eyes.setAttention('none', 'fresh')
    expect(f.root.dataset.mood).toBe('idle')
  })

  it('a fresh wait plays one motion 400 ms in, then stays still', () => {
    const f = face()
    f.eyes.setAttention('blocked', 'fresh')
    vi.advanceTimersByTime(399)
    expect(f.motion()).toBeNull()
    vi.advanceTimersByTime(1)
    const first = f.motion()
    expect(first).not.toBeNull()
    vi.advanceTimersByTime(MOTION_MS[first as Motion])
    expect(f.motion()).toBeNull()
    vi.advanceTimersByTime(30_000)
    expect(f.motion()).toBeNull()
  })

  /** Each motion as it starts: [ms since now, which]. */
  const motionStarts = (f: ReturnType<typeof face>, ms: number): [number, Motion][] => {
    const starts: [number, Motion][] = []
    let was: Motion | null = null
    for (let t = 0; t <= ms; t += 50) {
      const now = f.motion()
      if (now && !was) starts.push([t, now])
      was = now
      vi.advanceTimersByTime(50)
    }
    return starts
  }

  it.each(['rising', 'urgent'] as const)('a %s wait repeats a motion every 7-9 s', (stage) => {
    const f = face()
    f.eyes.setAttention('blocked', stage)
    const starts = motionStarts(f, 60_000).map(([t]) => t)
    expect(starts[0]).toBe(400)
    expect(starts.length).toBeGreaterThanOrEqual(7)
    // the repeats run on their own clock from the moment the wait began
    const repeats = [0, ...starts.slice(1)]
    const [lo, hi] = MOTION_EVERY_MS
    for (let i = 1; i < repeats.length; i++) {
      const gap = (repeats[i] as number) - (repeats[i - 1] as number)
      expect(gap).toBeGreaterThanOrEqual(lo - 50)
      expect(gap).toBeLessThanOrEqual(hi + 50)
    }
  })

  it('a rising wait never plays the same motion twice running', () => {
    const f = face()
    f.eyes.setAttention('blocked', 'rising')
    const seen = motionStarts(f, 60_000).map(([, m]) => m)
    expect(seen.length).toBeGreaterThanOrEqual(7)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1])
  })

  it('reduced motion keeps the bubble and attributes but never moves', () => {
    const f = face({ reducedMotion: true })
    f.eyes.setAttention('blocked', 'urgent')
    expect(f.bubble.textContent).toBe('?')
    expect(f.doc.dataset.attention).toBe('blocked')
    vi.advanceTimersByTime(30_000)
    expect(f.motion()).toBeNull()
  })
})

describe('a motion owns the gaze until it ends', () => {
  // nudge looks up at the "?" bubble
  const NUDGE = { x: `${(GAZE_MAX * 0.8).toFixed(1)}px`, y: `${(-GAZE_MAX * 0.7).toFixed(1)}px` }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a peer glance does not pull the eyes off a nudge', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9) // first motion: nudge
    const f = face()
    f.eyes.setAttention('blocked', 'rising')
    vi.advanceTimersByTime(450)
    expect(f.motion()).toBe('nudge')
    f.eyes.lookAtPeer(1200, 600, 0, 1700)
    vi.advanceTimersByTime(50)
    expect(f.gaze()).toEqual(NUDGE)
    vi.advanceTimersByTime(MOTION_MS.nudge - 600)
    expect(f.motion()).toBe('nudge')
    expect(f.gaze()).toEqual(NUDGE)
  })

  it('a glance already holding does not recentre the eyes over a motion', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const f = face()
    f.eyes.lookAtPeer(1200, 600, 100, 1000) // holds from 100 to 1100
    f.eyes.setAttention('blocked', 'fresh') // nudge from 400 to 1600
    vi.advanceTimersByTime(1150)
    expect(f.motion()).toBe('nudge')
    expect(f.gaze()).toEqual(NUDGE)
  })

  it('a motion cut short cannot end the next one early', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9) // nudge, then wiggle
    const f = face()
    f.eyes.setAttention('blocked', 'fresh') // nudge at 400, its end timer at 1600
    vi.advanceTimersByTime(500)
    f.eyes.setAttention('none', 'fresh') // a brief focus, say
    vi.advanceTimersByTime(100)
    f.eyes.setAttention('blocked', 'fresh') // wiggle at 1000, due to end at 2900
    vi.advanceTimersByTime(400)
    expect(f.motion()).toBe('wiggle')
    vi.advanceTimersByTime(MOTION_MS.wiggle - 1)
    expect(f.motion()).toBe('wiggle')
    vi.advanceTimersByTime(1)
    expect(f.motion()).toBeNull()
  })

  it('the darts of a wiggle cut short leave the next nudge alone', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // wiggle, then nudge
    const f = face()
    f.eyes.setAttention('blocked', 'fresh') // wiggle at 400, darts until 1250
    vi.advanceTimersByTime(450)
    expect(f.motion()).toBe('wiggle')
    f.eyes.setAttention('none', 'fresh')
    vi.advanceTimersByTime(50)
    f.eyes.setAttention('blocked', 'fresh') // nudge at 900
    vi.advanceTimersByTime(800)
    expect(f.motion()).toBe('nudge')
    expect(f.gaze()).toEqual(NUDGE)
  })
})

describe('timers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('an unfocused window runs only the blink and snore timers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // no double blink: its timer would make a fourth
    face()
    expect(vi.getTimerCount()).toBe(2)
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3) // blink, snore, a blink's reopen
  })

  it('the glance and exchange timers start on focus and stop when it goes', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // no double blink: its timer would make a fourth
    const f = face()
    f.eyes.setFocused(true) // + glance, exchange, and the surprised look's end
    expect(vi.getTimerCount()).toBe(5)
    vi.advanceTimersByTime(400)
    f.eyes.setFocused(false)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3)
    vi.advanceTimersByTime(120_000)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3)
  })

  it('an unfocused window never glances', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // every glance would fire
    const f = face()
    vi.advanceTimersByTime(30_000)
    expect(f.gaze()).toEqual({ x: undefined, y: undefined })
  })

  it('a focused window glances off-centre and back on the same cadence', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // glance fires, angle 0, radius 0.8
    const f = face({ focused: true })
    vi.advanceTimersByTime(2199)
    expect(f.gaze()).toEqual({ x: undefined, y: undefined })
    vi.advanceTimersByTime(1)
    expect(f.gaze()).toEqual({ x: '0.8px', y: '0.0px' })
    vi.advanceTimersByTime(500) // back to centre after 500-1300 ms
    expect(f.gaze()).toEqual({ x: '0.0px', y: '0.0px' })
    vi.advanceTimersByTime(1400) // next glance 1.9-4.6 s after the last
    expect(f.gaze()).toEqual({ x: '0.8px', y: '0.0px' })
  })

  it('asleep, a "z" still drifts up every few seconds', () => {
    const f = face()
    vi.advanceTimersByTime(6 * 60_000 + 4200)
    expect(f.root.dataset.mood).toBe('asleep')
    expect(f.root.classes.has('snore')).toBe(true)
  })

  it('says once when the eyes fall asleep and once when they wake', () => {
    const f = face()
    const heard: boolean[] = []
    f.eyes.onSleep((asleep) => heard.push(asleep))
    vi.advanceTimersByTime(ASLEEP_AFTER_MS - 5000)
    expect(heard).toEqual([])
    vi.advanceTimersByTime(10_000) // the next snore settles the mood
    expect(heard).toEqual([true])
    vi.advanceTimersByTime(60_000)
    expect(heard).toEqual([true])
    f.eyes.noticeInput()
    expect(heard).toEqual([true, false])
    vi.advanceTimersByTime(60_000)
    expect(heard).toEqual([true, false])
  })

  it('the sleep signal follows the quiet clock, not a held mood', () => {
    const f = face()
    const heard: boolean[] = []
    f.eyes.onSleep((asleep) => heard.push(asleep))
    f.eyes.setAttention('finished', 'fresh')
    vi.advanceTimersByTime(ASLEEP_AFTER_MS + 10_000)
    expect(f.root.dataset.mood).toBe('content')
    expect(heard).toEqual([true])
    f.eyes.setAttention('none', 'fresh')
    vi.advanceTimersByTime(10_000)
    expect(heard).toEqual([true]) // no second nap in the same quiet spell
    f.eyes.noticeInput()
    expect(heard).toEqual([true, false])
  })

  it('dispose clears every timer, the click handler and a half-played blink', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9) // nudge
    const f = face({ focused: true })
    f.eyes.setFocused(false)
    f.eyes.setAttention('blocked', 'rising')
    f.eyes.setBusy(true)
    vi.advanceTimersByTime(800)
    f.eyes.setBusy(true) // reading saccades
    f.eyes.lookAtPeer(100, 100, 50, 1000)
    f.root.classes.add('blink')
    expect(vi.getTimerCount()).toBeGreaterThan(4)
    f.eyes.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.root.listeners).toBe(0)
    expect(f.root.classes.has('blink')).toBe(false)
    expect(f.motion()).toBeNull()
  })
})
