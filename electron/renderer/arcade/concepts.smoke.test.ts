// Every titlebar game, run through the real engine for a few simulated minutes
// on a fake DOM: it loads, reacts to the cursor, keys, work and a resize, parks
// once things go quiet, naps when the eyes fall asleep (its nap hooks run once,
// then it parks again), and leaves nothing behind when it is destroyed.
//
// Concepts load from their files (not games.ts's import.meta.glob loader) and
// the canvas is a recording fake, so this covers runtime errors, the frame cap,
// parking and teardown, not pixels. Math.random is seeded per game, so a run is
// deterministic: set ARCADE_CALL_LOG=<dir> to write each game's canvas call log
// there and diff two runs to prove a refactor changed nothing on screen (the
// titlebar's own canvas logs as `stage.`; sprite canvases as `e<n>.`).
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Actor,
  conceptFor,
  FAST,
  installGlobals,
  NAP_PLAY_MS,
  REST_AFTER,
  Strip,
} from './engine'
import { GAMES } from './games'

// ---- fake DOM ------------------------------------------------------------------
const LOG_DIR = process.env.ARCADE_CALL_LOG
let log: string[] = []
const arg = (v: unknown): string =>
  typeof v === 'number'
    ? String(Math.round(v * 1000) / 1000)
    : typeof v === 'object'
      ? typeof v
      : String(v)

function fakeContext(canvas: FakeEl): CanvasRenderingContext2D {
  const state: Record<PropertyKey, unknown> = {}
  return new Proxy(state, {
    get(t, p) {
      if (p === 'canvas') return canvas
      if (p in t) return t[p]
      return (...a: unknown[]) => {
        if (LOG_DIR) log.push(`${canvas.id}.${String(p)}(${a.map(arg).join(',')})`)
        if (p === 'measureText') return { width: String(a[0]).length * 4 }
        if (p === 'getImageData') {
          const [, , w, h] = a as number[]
          return { data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }
        }
        if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern')
          return { addColorStop() {} }
        return undefined
      }
    },
    set(t, p, v) {
      if (LOG_DIR) log.push(`${canvas.id}.${String(p)}=${arg(v)}`)
      t[p] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

let nextId = 0
class FakeEl extends EventTarget {
  id = `e${nextId++}`
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  hidden = false
  className = ''
  width = 300
  height = 150
  clientWidth = 900
  offsetParent: object | null = null
  rect = { left: 0, top: 0, width: 0, height: 0 }
  kids: FakeEl[] = []
  private ctx?: CanvasRenderingContext2D
  constructor(readonly tagName = 'DIV') {
    super()
  }
  getContext(): CanvasRenderingContext2D {
    this.ctx ??= fakeContext(this)
    return this.ctx
  }
  getBoundingClientRect() {
    const r = this.rect
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }
  }
  setAttribute() {}
  setPointerCapture() {}
  append(...k: FakeEl[]) {
    this.kids.push(...k)
  }
  remove() {}
  contains(n: unknown) {
    return n === this || this.kids.includes(n as FakeEl)
  }
}

/** A titlebar with the furniture games stand on and bump into. */
function titlebar(): { bar: FakeEl; parts: Record<string, FakeEl> } {
  const bar = new FakeEl()
  bar.rect = { left: 0, top: 0, width: 900, height: 36 }
  const part = (left: number, width: number) => {
    const e = new FakeEl()
    e.offsetParent = bar
    e.rect = { left, top: 6, width, height: 24 }
    return e
  }
  const parts: Record<string, FakeEl> = {
    '#eyes': part(8, 28),
    '#wname:not([hidden]), #wname-input:not([hidden])': part(44, 160),
    '#lantern-menu-btn': part(210, 20),
    '.controls': part(820, 72),
    '.ctl.min': part(824, 16),
    '.ctl.max': part(848, 16),
    '.ctl.close': part(872, 16),
  }
  const b = bar as FakeEl & Record<string, unknown>
  b.querySelector = (sel: string) => parts[sel] ?? null
  b.querySelectorAll = () => [
    parts['#eyes'],
    parts['.ctl.min'],
    parts['.ctl.max'],
    parts['.ctl.close'],
  ]
  return { bar, parts }
}

const observers: (() => void)[] = []
const win = new EventTarget()
const doc = new EventTarget()
Object.assign(doc, { hidden: false, createElement: (tag: string) => new FakeEl(tag.toUpperCase()) })
const g = globalThis as unknown as Record<string, unknown>
Object.assign(g, {
  document: doc,
  window: g,
  addEventListener: win.addEventListener.bind(win),
  removeEventListener: win.removeEventListener.bind(win),
  devicePixelRatio: 1,
  location: { search: '' },
  ResizeObserver: class {
    private cb: () => void
    constructor(cb: () => void) {
      this.cb = cb
    }
    observe() {
      observers.push(this.cb)
    }
    disconnect() {
      const i = observers.indexOf(this.cb)
      if (i >= 0) observers.splice(i, 1)
    }
  },
})

function pointer(type: string, x: number, y: number): Event {
  return Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: y })
}
function key(type: 'keydown' | 'keyup', code: string): Event {
  const k = code === 'Space' ? ' ' : code.replace(/^Key|^Arrow/, '')
  return Object.assign(new Event(type, { cancelable: true }), {
    code,
    key: k,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  })
}

/** Seeded Math.random (mulberry32), so every run of a game is the same. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- the run -------------------------------------------------------------------
const keys = readdirSync(new URL('./concepts', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .map((f) => f.slice(0, -3))
  .sort()

let strip: Strip | null = null
afterEach(() => {
  strip?.destroy()
  strip = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SEED = 0x5eed

/** Every other game has a nap hook of its own (Lounge Adventure's does nothing);
 * these nap their characters instead, and Vector Escape has no nap at all. */
const ACTOR_NAPS = new Set(['birds', 'walkerrescue'])
const NO_NAP = new Set(['vectorescape'])

/** One run of a game: cursor, keys, work, a resize, then quiet until it parks,
 * a nap and the wake from it, then teardown. */
async function play(k: string, seed: number, quietMs = 180_000): Promise<void> {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  })
  vi.spyOn(Math, 'random').mockImplementation(seeded(seed))
  const errors = vi.spyOn(console, 'error')
  const draws = vi.spyOn(Strip.prototype as unknown as { draw(): void }, 'draw')
  log = []
  nextId = 0
  installGlobals()
  await import(`./concepts/${k}.js`)
  const def = conceptFor(k)
  if (!def) throw new Error(`${k} registered no concept`)
  expect(def.title).toBe(GAMES.find((x) => x.key === k)?.name)
  const { bar, parts } = titlebar()
  const s = new Strip(def, bar as unknown as HTMLElement, { gaze() {} })
  strip = s
  ;(s.canvas as unknown as FakeEl).id = 'stage'
  const tick = (ms: number) => vi.advanceTimersByTime(ms)

  // 10 s of a cursor sweeping the bar, clicking the first character it finds
  let clicked = false
  for (let t = 0; t < 100; t++) {
    const p = { x: (t * 37) % 900, y: 4 + ((t * 7) % 28) }
    s.setCursor(p)
    if (!clicked && s.actorAt(p)) {
      clicked = true
      bar.kids[1]?.dispatchEvent(pointer('pointerdown', p.x, p.y))
      bar.kids[1]?.dispatchEvent(pointer('pointerup', p.x, p.y))
    }
    tick(100)
  }
  s.setCursor(null)
  parts['.ctl.close']?.dispatchEvent(pointer('pointerdown', 880, 18))

  // 10 s of keyboard play
  s.arm(true)
  const codes = ['KeyD', 'Space', 'KeyA', 'ArrowUp', 'KeyD', 'Space', 'ArrowDown', 'KeyW']
  for (let t = 0; t < 20; t++) {
    const code = codes[t % codes.length] as string
    win.dispatchEvent(key('keydown', code))
    tick(300)
    win.dispatchEvent(key('keyup', code))
    tick(200)
  }
  s.arm(false)

  // 20 s of work, then done and 10 s of the finish: never past 12 fps
  draws.mockClear()
  s.setBusy(true)
  tick(20_000)
  expect(draws.mock.calls.length).toBeLessThanOrEqual(Math.ceil(20_000 / FAST) + 2)
  s.setBusy(false)
  tick(10_000)

  // the window narrows; the window controls stay at its right edge
  bar.clientWidth = 600
  bar.rect.width = 600
  for (const sel of ['.controls', '.ctl.min', '.ctl.max', '.ctl.close'])
    (parts[sel] as FakeEl).rect.left -= 300
  for (const cb of [...observers]) cb()
  win.dispatchEvent(new Event('resize'))

  // quiet (3 minutes unless a case says sooner): the vignette settles and the loop stops
  tick(quietMs)
  expect(s.mode).toBe('parked')
  draws.mockClear()
  tick(60_000)
  expect(draws).not.toHaveBeenCalled()

  // the eyes fall asleep: every nap hook runs once, the nap plays a few seconds
  // at most, then the loop parks again; a second "asleep" changes nothing
  const naps = [
    ...(def.onNap ? [vi.spyOn(def as Required<typeof def>, 'onNap')] : []),
    ...s.actors
      .filter((a) => a.onNap)
      .map((a) => vi.spyOn(a as Required<Actor>, 'onNap').mockName('actor')),
  ]
  s.nap(true)
  s.nap(true)
  expect(s.napping).toBe(true)
  for (const n of naps) expect(n).toHaveBeenCalledTimes(1)
  expect(Boolean(def.onNap)).toBe(!NO_NAP.has(k) && !ACTOR_NAPS.has(k))
  draws.mockClear()
  tick(NAP_PLAY_MS + 2 * FAST)
  expect(draws.mock.calls.length).toBeLessThanOrEqual(Math.ceil(NAP_PLAY_MS / FAST) + 2)
  expect(s.mode).toBe('parked')
  draws.mockClear()
  tick(60_000)
  expect(draws).not.toHaveBeenCalled()

  // waking ends the nap; asleep again naps again, and typing wakes it too
  s.nap(false)
  expect(s.napping).toBe(false)
  tick(NAP_PLAY_MS)
  s.nap(true)
  for (const n of naps) expect(n).toHaveBeenCalledTimes(2)
  tick(NAP_PLAY_MS + 2 * FAST)
  expect(s.mode).toBe('parked')
  s.touch()
  expect(s.napping).toBe(false)
  tick(quietMs)
  expect(s.mode).toBe('parked')
  draws.mockClear()
  tick(60_000)
  expect(draws).not.toHaveBeenCalled()

  // a game at work or being played never naps mid-run: the nap waits until
  // the game goes quiet, then runs once and parks as before
  s.nap(false)
  const gameNap = def.onNap ? vi.spyOn(def as Required<typeof def>, 'onNap') : null
  gameNap?.mockClear()
  s.setBusy(true)
  s.nap(true)
  expect(s.napping).toBe(false)
  tick(5_000)
  s.setBusy(false)
  tick(REST_AFTER / 2)
  expect(s.napping).toBe(false)
  if (gameNap) expect(gameNap).not.toHaveBeenCalled()
  tick(quietMs)
  expect(s.napping).toBe(true)
  if (gameNap) expect(gameNap).toHaveBeenCalledTimes(1)
  expect(s.mode).toBe('parked')
  draws.mockClear()
  tick(60_000)
  expect(draws).not.toHaveBeenCalled()

  expect(errors).not.toHaveBeenCalled()
  s.destroy()
  strip = null
  expect(s.mode).toBe('destroyed')
  expect(vi.getTimerCount()).toBe(0)
  expect(observers).toHaveLength(0)

  if (LOG_DIR && seed === SEED) {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(join(LOG_DIR, `${k}.log`), `${log.join('\n')}\n`)
  }
}

describe('titlebar games', () => {
  it('ships all nineteen, each in the picker', () => {
    expect(keys).toHaveLength(19)
    expect(GAMES.map((x) => x.key).sort()).toEqual(keys)
  })

  it.each(keys)('%s runs, parks when quiet, naps and tears down clean', (k) => play(k, SEED))

  // Seeds a full sweep found each hit one of the parking bugs fixed in these
  // games: without the fix the game never parks, or (floating bread) parks only
  // once the bread goes stale at 150 s.
  it.each<[game: string, seed: number, quietMs: number, fix: string]>([
    ['birds', 8, 180_000, 'birds give up on bread that went stale'],
    ['birds', 1, 60_000, 'birds give up on bread left floating when its perch moved'],
    ['suitexplorer', 35, 180_000, 'the explorer turns around to walk to her resting spot'],
  ])('%s seed %i parks within %i ms: %s', (k, seed, quietMs) => play(k, seed, quietMs))
})
