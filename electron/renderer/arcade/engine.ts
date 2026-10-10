// Titlebar arcade engine: a pixel-art game vignette living in the window's
// titlebar. One canvas over the bar, sprites built once, a loop that runs at
// 12 fps only while something moves, 4 fps for slow drifts, and parks (no timer
// at all) when the vignette rests, the window is hidden, or nobody is around.
//
// Concepts (./concepts/*.js) are plain scripts written against a small global
// API (sprite helpers, constants, registerConcept); installGlobals() provides it
// so the same files run here and in the design mockups.

/* Concepts are untyped scripts; the engine passes their objects through. */
type Sprite = HTMLCanvasElement
export interface Point {
  x: number
  y: number
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
  kind?: string
  el?: HTMLElement
}
export interface Actor {
  update(dt: number, now: number, s: Strip): number | undefined
  draw(c: CanvasRenderingContext2D, s: Strip): void
  x?: number
  y?: number
  z?: number
  moving?: boolean
  asleep?: boolean
  prop?: boolean
  dead?: boolean
  grabbable?: boolean
  hit?(x: number, y: number): boolean
  onClick?(p: Point): void
  onDblClick?(p: Point): void
  grab?(p: Point): void
  drag?(p: Point): void
  drop?(p: Point): void
  onBarClick?(p: Point): void
  onBusy?(): void
  onDone?(ranMs: number): void
  onNap?(): void
  bonked?(r: Rect, kind?: string): void
}
export interface ConceptDef {
  key: string
  title?: string
  setup(s: Strip): void
  update?(s: Strip, dt: number, now: number): number | undefined
  drawBehind?(s: Strip, c: CanvasRenderingContext2D): void
  drawFront?(s: Strip, c: CanvasRenderingContext2D): void
  relayout?(s: Strip): void
  onBusy?(s: Strip): void
  onDone?(s: Strip, ranMs: number): void
  onNap?(s: Strip): void
  onBonk?(s: Strip, r: Rect, kind?: string): void
}
interface Particle {
  age: number
  life: number
  x: number
  y: number
  vx?: number
  vy?: number
  g?: number
  fade?: boolean
  img?: Sprite
  text?: string
  digits?: string
  color?: string
  size?: number
  follow?: { x: number }
  dx?: number
}
export interface Cursor extends Point {
  t: number
  speed: number
  since: number
}

// ---- constants & sprite helpers ------------------------------------------------
export const H = 36 // titlebar height (CSS px); keep in step with .titlebar
export const FLOOR = H // feet line: the top edge of the terminal
export const FAST = 1000 / 12
export const SLOW = 250
export const REST_AFTER = 30_000 // quiet ms before a vignette settles
const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)] as T
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

type Palette = Record<string, string>
export const PAL: Palette = {
  G: '#56d24e',
  g: '#2f9a2f',
  S: '#f3c39c',
  s: '#c98e6a',
  B: '#4a6ee0',
  D: '#2c3f8f',
  W: '#f2efe6',
  R: '#d9473f',
  K: '#c58b4a',
  k: '#7a5428',
  Y: '#f2d14b',
  O: '#f08a2c',
  n: '#9a7b5c',
  N: '#e2d2bb',
  E: '#151515',
  L: '#e5a647',
  w: '#ffffff',
  b: '#2b5fd9',
  c: '#7fd8ff',
  p: '#ff8fb3',
  r: '#ff5a5a',
  y: '#ffd93d',
  a: '#8a8f98',
  A: '#c7ccd4',
  m: '#b05cff',
  t: '#3fbf9f',
  v: '#5a2d82',
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const x = c.getContext('2d') as CanvasRenderingContext2D
  return [c, x]
}
/** A sprite canvas from rows of palette letters ('.' or unknown = clear). */
export function sprite(rows: readonly string[], pal: Palette = PAL): Sprite {
  const [c, x] = canvas(Math.max(...rows.map((r) => r.length)), rows.length)
  rows.forEach((r, y) => {
    ;[...r].forEach((ch, i) => {
      const col = pal[ch]
      if (col) {
        x.fillStyle = col
        x.fillRect(i, y, 1, 1)
      }
    })
  })
  return c
}
export function mirror(src: Sprite): Sprite {
  const [c, x] = canvas(src.width, src.height)
  x.translate(src.width, 0)
  x.scale(-1, 1)
  x.drawImage(src, 0, 0)
  return c
}
/** A sprite facing right (1) plus its mirror (-1): sp[dir]. */
export function pair(rows: readonly string[], pal: Palette = PAL) {
  const r = sprite(rows, pal)
  return { 1: r, '-1': mirror(r), w: r.width, h: r.height }
}
/** A copy with a 1px dark outline, 2px larger: draw it at (x - 1, y - 1). */
export function outline(src: Sprite, color = 'rgba(8,9,11,.92)'): Sprite {
  const [c, x] = canvas(src.width + 2, src.height + 2)
  const [t, tx] = canvas(src.width, src.height)
  tx.drawImage(src, 0, 0)
  tx.globalCompositeOperation = 'source-in'
  tx.fillStyle = color
  tx.fillRect(0, 0, t.width, t.height)
  for (const [dx, dy] of [
    [0, 1],
    [2, 1],
    [1, 0],
    [1, 2],
  ] as const)
    x.drawImage(t, dx, dy)
  x.drawImage(src, 1, 1)
  return c
}
export function pairOutlined(rows: readonly string[], pal: Palette = PAL, color?: string) {
  const r = outline(sprite(rows, pal), color)
  return { 1: r, '-1': mirror(r), w: r.width, h: r.height }
}
/** Recolor a sprite grid by mapping letters: recolor(rows, {B:'R'}). */
export function recolor(rows: readonly string[], map: Record<string, string>): string[] {
  return rows.map((r) => [...r].map((ch) => map[ch] ?? ch).join(''))
}

const DIGIT_ROWS: Record<string, string[]> = {
  0: ['www', 'w.w', 'w.w', 'w.w', 'www'],
  1: ['.w.', 'ww.', '.w.', '.w.', 'www'],
  2: ['www', '..w', 'www', 'w..', 'www'],
  3: ['www', '..w', '.ww', '..w', 'www'],
  4: ['w.w', 'w.w', 'www', '..w', '..w'],
  5: ['www', 'w..', 'www', '..w', 'www'],
  6: ['www', 'w..', 'www', 'w.w', 'www'],
  7: ['www', '..w', '.w.', '.w.', '.w.'],
  8: ['www', 'w.w', 'www', 'w.w', 'www'],
  9: ['www', 'w.w', 'www', '..w', 'www'],
  '+': ['...', '.w.', 'www', '.w.', '...'],
}
let DIGITS: Record<string, Sprite> = {}
/** Draw a number/'+' string with the 3x5 font; returns its width. */
export function drawDigits(c: CanvasRenderingContext2D, str: string, x: number, y: number): number {
  let dx = 0
  for (const ch of String(str)) {
    const g = DIGITS[ch]
    if (g) c.drawImage(g, Math.round(x + dx), Math.round(y))
    dx += 4
  }
  return dx
}
const PIX: Record<string, Sprite> = {}
/** A cached 1x1 pixel sprite for palette letter k. */
export const pix = (k: string): Sprite => {
  PIX[k] ??= sprite([k])
  return PIX[k]
}

// ---- concept registry -----------------------------------------------------------
const CONCEPTS: ConceptDef[] = []
export function conceptFor(key: string): ConceptDef | undefined {
  return CONCEPTS.find((c) => c.key === key)
}

let installed = false
/** Provide the globals concept scripts are written against. */
export function installGlobals(): void {
  if (installed) return
  installed = true
  DIGITS = Object.fromEntries(Object.entries(DIGIT_ROWS).map(([k, rows]) => [k, sprite(rows)]))
  const g = globalThis as unknown as Record<string, unknown>
  Object.assign(g, {
    H,
    FLOOR,
    FAST,
    SLOW,
    REST_AFTER,
    rand,
    pick,
    clamp,
    zoom: 1,
    PAL,
    sprite,
    mirror,
    pair,
    pairOutlined,
    outline,
    recolor,
    DIGITS,
    drawDigits,
    pix,
    ZZ: sprite(['www', '..w', '.w.', 'www']),
    STAR: sprite(['.y.', 'yyy', '.y.']),
    CONFETTI: ['r', 'y', 'b', 'G', 'p', 'c'].map((k) => sprite([k])),
    BUBBLE: {
      '!': sprite(['wwwww', 'ww.ww', 'ww.ww', 'wwwww', 'ww.ww', 'wwwww', '.w...']),
      '♥': sprite(['wwwwwww', 'wr.wr.w', 'wrrrrrw', 'w.rrr.w', 'ww.r.ww', 'wwwwwww', '.w.....']),
      '…': sprite(['wwwwwww', 'wwwwwww', 'w.w.w.w', 'wwwwwww', '.w.....']),
      '♪': sprite(['...ww', '...w.', '...w.', '.www.', '.ww..']),
      '?': sprite(['wwwww', 'w...w', 'www.w', 'ww.ww', 'wwwww', 'ww.ww', 'wwwww', '.w...']),
    },
    registerConcept: (def: ConceptDef) => CONCEPTS.push(def),
    wake: () => current?.poke(),
  })
}
let current: Strip | null = null

// Titlebar furniture the vignettes know about, by kind.
const FURNITURE: readonly (readonly [string, string])[] = [
  ['eyes', '#eyes'],
  ['title', '#wname:not([hidden]), #wname-input:not([hidden])'],
  ['glyph', '#lantern-menu-btn'],
  ['controls', '.controls'],
  ['min', '.ctl.min'],
  ['max', '.ctl.max'],
  ['close', '.ctl.close'],
]
// Anything clickable in the bar: the character pad never covers these.
const INTERACTIVE = 'button, input, #eyes, .pinned > *, .mandate-warn:not([hidden])'

export interface StripHooks {
  /** Where the eyes should look (client px), or null for "your call". */
  gaze?(pt: Point | null): void
}

// ---- one titlebar ------------------------------------------------------------------
export class Strip {
  readonly kind: string
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly pad: HTMLElement
  actors: Actor[] = []
  parts: Particle[] = []
  fix: Rect[] = []
  dots: Rect[] = []
  private buttons: Rect[] = []
  W = 0
  scale = 1
  cursor: Cursor | null = null
  busy = false
  busySince = 0
  lastActive = performance.now()
  lastTouch = performance.now()
  napping = false
  visible = !document.hidden
  data: Record<string, unknown> = {}
  mode = 'parked'
  private nextAt = 0
  private lastStep = performance.now()
  private timer: number | undefined
  private down: (Point & { actor: Actor; dragging: boolean }) | null = null
  private lastGaze: Point | null = null

  constructor(
    readonly def: ConceptDef,
    readonly bar: HTMLElement,
    private readonly hooks: StripHooks = {},
  ) {
    this.kind = def.key
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'arcade-stage'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D
    this.pad = document.createElement('div')
    this.pad.className = 'arcade-pad'
    this.pad.hidden = true
    bar.append(this.canvas, this.pad)
    current = this
    this.layout()
    def.setup(this)
    this.bindPointer()
    new ResizeObserver(() => this.relayout()).observe(bar)
    window.addEventListener('resize', () => this.relayout())
    const title = bar.querySelector('.tag')
    if (title) new ResizeObserver(() => this.relayout()).observe(title)
    document.addEventListener('visibilitychange', () => {
      this.visible = !document.hidden
      if (this.visible) this.poke()
    })
    this.poke()
  }

  private rel(el: Element): Rect {
    const b = this.bar.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }
  }

  layout(): void {
    this.W = this.bar.clientWidth
    const all: Rect[] = []
    for (const [kind, sel] of FURNITURE) {
      const el = this.bar.querySelector<HTMLElement>(sel)
      if (!el || el.offsetParent === null) continue
      const r = this.rel(el)
      if (kind === 'title') {
        // the lettering, not the button's padding
        r.y += 3
        r.h = Math.max(6, r.h - 6)
      }
      all.push({ ...r, kind, el })
    }
    this.fix = all.filter((f) => ['eyes', 'title', 'glyph', 'controls'].includes(f.kind ?? ''))
    this.dots = all.filter((f) => ['min', 'max', 'close'].includes(f.kind ?? ''))
    this.buttons = [...this.bar.querySelectorAll(INTERACTIVE)]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => this.rel(el))
    const dpr = window.devicePixelRatio || 1
    this.canvas.style.width = `${this.W}px`
    this.canvas.style.height = `${H}px`
    this.canvas.width = Math.round(this.W * dpr)
    this.canvas.height = Math.round(H * dpr)
    this.scale = dpr
    this.nextAt = 0 // resizing cleared the canvas
  }
  private relayout(): void {
    this.layout()
    this.def.relayout?.(this)
    this.poke()
  }

  fixture(kind: string): Rect {
    return this.fix.find((f) => f.kind === kind) ?? { x: this.W / 2, y: 12, w: 0, h: 12, kind }
  }
  fixtureOver(x0: number, x1 = x0): Rect | undefined {
    return this.fix.find((f) => x1 >= f.x && x0 <= f.x + f.w)
  }
  groundAt(x0: number, x1: number, y: number, step = 2, extra: Rect[] | null = null): number {
    let g = FLOOR
    for (const f of extra ? [...this.fix, ...extra] : this.fix)
      if (x1 >= f.x && x0 <= f.x + f.w && f.y >= y - step && f.y < g) g = f.y
    return g
  }
  spawn<A extends Actor>(a: A): A {
    this.actors.push(a)
    this.poke()
    return a
  }
  particle(p: Omit<Particle, 'age'> & { life: number }): void {
    this.parts.push({ age: 0, ...p })
    this.poke()
  }
  /** Floating text (speech, scores), drawn with a dark outline. */
  say(
    text: string,
    x: number,
    y: number,
    opts: {
      life?: number
      color?: string
      vy?: number
      follow?: { x: number }
      fade?: boolean
      size?: number
    } = {},
  ): void {
    this.parts.push({
      age: 0,
      text,
      x,
      y,
      life: opts.life ?? 2.5,
      color: opts.color ?? '#ffffff',
      vy: opts.vy ?? 0,
      follow: opts.follow,
      fade: opts.fade ?? false,
      size: opts.size ?? 7,
    })
    this.poke()
  }
  burst(x: number, y: number, n = 16, colors = ['r', 'y', 'O', 'w']): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = rand(15, 55)
      this.particle({
        img: pix(pick(colors)),
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 15,
        g: 90,
        life: rand(0.6, 1.2),
        fade: true,
      })
    }
  }
  /** True while someone is around or work is happening; vignettes settle into
   * a resting pose (and park) once this goes false. */
  lively(now = performance.now()): boolean {
    if (this.napping) return false
    return this.busy || now - this.lastTouch < REST_AFTER
  }
  idleFor(now = performance.now()): number {
    return this.napping ? 1e9 : this.busy ? 0 : now - this.lastActive
  }
  actorAt(p: Point): Actor | null {
    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i] as Actor
      if (!a.dead && a.hit?.(p.x, p.y)) return a
    }
    return null
  }

  // ---- signals from Aico -------------------------------------------------------
  /** The cursor in bar coordinates, or null when it is away from the bar. */
  setCursor(p: Point | null): void {
    const now = performance.now()
    if (!p) {
      if (!this.cursor) return
      this.cursor = null
      if (!this.down) this.showPad(null)
      this.poke()
      return
    }
    this.lastTouch = now
    this.napping = false
    const prev = this.cursor
    const dt = prev ? Math.max(16, now - prev.t) : 1000
    const speed = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / (dt / 1000) : 0
    this.cursor = {
      ...p,
      t: now,
      speed: prev ? prev.speed * 0.5 + speed * 0.5 : 0,
      since: prev && speed <= 40 ? prev.since : now,
    }
    if (!this.down) this.showPad(p)
    // at 12 fps the next frame picks the cursor up; otherwise wake the loop
    if (this.mode !== 'fast') this.poke()
  }
  /** Someone is at the keyboard: the vignette stays lively. */
  touch(): void {
    this.lastTouch = performance.now()
    if (this.napping || !this.lively()) this.poke()
    this.napping = false
  }
  setBusy(on: boolean, ranMs = 0): void {
    if (on === this.busy) return
    this.busy = on
    this.napping = false
    const now = performance.now()
    if (on) this.busySince = now
    const ran = on ? 0 : ranMs || now - this.busySince
    for (const a of this.actors) {
      if (on) a.onBusy?.()
      else a.onDone?.(ran)
    }
    if (on) this.def.onBusy?.(this)
    else this.def.onDone?.(this, ran)
    this.lastActive = now
    this.lastTouch = now
    this.poke()
  }
  /** A titlebar button was pressed: actors may react to the bump. */
  bonk(el: HTMLElement, kind?: string): void {
    const r = this.rel(el)
    this.lastTouch = performance.now()
    for (const a of this.actors) a.bonked?.(r, kind)
    this.def.onBonk?.(this, r, kind)
    this.poke()
  }

  // ---- pointer: a small no-drag pad follows the cursor while it is over a
  // character, so presses there reach the page instead of moving the window.
  private overButton(p: Point): boolean {
    return this.buttons.some(
      (b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h,
    )
  }
  private showPad(p: Point | null): void {
    const a = p && p.y >= 0 && p.y <= H && !this.overButton(p) ? this.actorAt(p) : null
    if (!a || !p) {
      if (!this.pad.hidden) this.pad.hidden = true
      return
    }
    this.pad.style.transform = `translate(${Math.round(p.x - 10)}px, ${Math.round(p.y - 10)}px)`
    if (this.pad.hidden) this.pad.hidden = false
  }
  private bindPointer(): void {
    const local = (e: MouseEvent): Point => {
      const r = this.bar.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    this.bar.addEventListener('mousemove', (e) => {
      if (!this.down) this.setCursor(local(e))
    })
    this.pad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const p = local(e)
      const actor = this.actorAt(p)
      this.lastTouch = performance.now()
      if (!actor) return
      e.preventDefault()
      this.pad.setPointerCapture(e.pointerId)
      this.down = { ...p, actor, dragging: false }
      this.poke()
    })
    this.pad.addEventListener('pointermove', (e) => {
      const d = this.down
      if (!d) return
      const p = local(e)
      this.pad.style.transform = `translate(${Math.round(p.x - 10)}px, ${Math.round(p.y - 10)}px)`
      if (!d.dragging && Math.hypot(p.x - d.x, p.y - d.y) > 3 && d.actor.grabbable) {
        d.dragging = true
        d.actor.grab?.(p)
      }
      if (d.dragging) d.actor.drag?.(p)
      this.poke()
    })
    const release = (e: PointerEvent): void => {
      const d = this.down
      this.down = null
      if (!d) return
      const p = local(e)
      if (d.dragging) d.actor.drop?.(p)
      else if (e.type === 'pointerup') d.actor.onClick?.(p)
      this.showPad(p)
      this.poke()
    }
    this.pad.addEventListener('pointerup', release)
    this.pad.addEventListener('pointercancel', release)
    this.pad.addEventListener('dblclick', (e) => {
      this.actorAt(local(e))?.onDblClick?.(local(e))
      this.poke()
    })
    for (const [kind, sel] of [
      ['min', '.ctl.min'],
      ['max', '.ctl.max'],
      ['close', '.ctl.close'],
    ] as const) {
      const el = this.bar.querySelector<HTMLElement>(sel)
      el?.addEventListener('pointerdown', () => this.bonk(el, kind))
    }
  }

  // ---- the loop ------------------------------------------------------------------
  poke(): void {
    this.nextAt = 0
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.loop(), 0)
  }
  private loop(): void {
    this.timer = undefined
    if (!this.visible) {
      this.mode = 'hidden'
      return
    }
    const want = this.tick(performance.now())
    if (this.timer !== undefined) return // poked during the tick: already rescheduled
    if (want < 1e11) this.timer = window.setTimeout(() => this.loop(), Math.max(4, want))
  }
  private tick(now: number): number {
    if (now < this.nextAt) return this.nextAt - now
    const dt = Math.min(0.25, (now - this.lastStep) / 1000)
    this.lastStep = now
    let want = Infinity
    try {
      const d = this.def.update?.(this, dt, now)
      if (d !== undefined) want = Math.min(want, d)
      for (const a of this.actors)
        if (!a.dead) want = Math.min(want, a.update(dt, now, this) ?? Infinity)
    } catch (err) {
      // A broken vignette must never take the window with it: stop drawing.
      console.error('[arcade]', this.kind, err)
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      this.mode = 'failed'
      return Infinity
    }
    this.actors = this.actors.filter((a) => !a.dead)
    let slowOnly = true
    this.parts = this.parts.filter((p) => {
      p.age += dt
      if (p.follow) p.x = p.follow.x + (p.dx ?? 0)
      p.x += (p.vx ?? 0) * dt
      p.y += (p.vy ?? 0) * dt
      if (p.g) p.vy = (p.vy ?? 0) + p.g * dt
      if (p.vx || (p.vy && Math.abs(p.vy) > 6) || p.g) slowOnly = false
      return p.age < p.life
    })
    if (this.parts.length) want = Math.min(want, slowOnly ? SLOW : FAST)
    want = Math.max(want, FAST) // 12 fps is the ceiling, whatever a vignette asks for
    this.updateGaze()
    this.draw()
    this.mode =
      want <= FAST + 1
        ? 'fast'
        : want <= SLOW + 1
          ? 'slow'
          : want === Infinity
            ? 'parked'
            : 'waiting'
    this.nextAt = now + (want === Infinity ? 1e12 : want)
    return want
  }
  /** With no cursor about, the eyes follow the nearest moving character. */
  private updateGaze(): void {
    if (!this.hooks.gaze) return
    let t: Point | null = null
    if (!this.cursor) {
      const e = this.fixture('eyes')
      const cx = e.x + e.w / 2
      let best = Infinity
      for (const a of this.actors)
        if (a.moving && a.x !== undefined) {
          const dd = Math.abs(a.x - cx)
          if (dd < best) {
            best = dd
            t = { x: a.x + 3, y: (a.y ?? FLOOR) - 6 }
          }
        }
    }
    const last = this.lastGaze
    if (t && last && Math.abs(t.x - last.x) < 3 && Math.abs(t.y - last.y) < 3) return
    if (!t && !last) return
    this.lastGaze = t
    const b = this.bar.getBoundingClientRect()
    this.hooks.gaze(t ? { x: b.left + t.x, y: b.top + t.y } : null)
  }
  private draw(): void {
    const c = this.ctx
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0)
    c.imageSmoothingEnabled = false
    c.clearRect(0, 0, this.W, H)
    this.def.drawBehind?.(this, c)
    const sorted = this.actors.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
    for (const a of sorted) a.draw(c, this)
    for (const p of this.parts) {
      c.globalAlpha = p.fade ? clamp(1 - p.age / p.life, 0, 1) : 1
      if (p.text !== undefined) {
        c.font = `bold ${p.size ?? 7}px "DejaVu Sans Mono", Menlo, monospace`
        c.textBaseline = 'top'
        const w = c.measureText(p.text).width
        const x = Math.round(clamp(p.x - w / 2, 1, this.W - w - 1))
        const y = Math.round(p.y)
        c.lineWidth = 2
        c.strokeStyle = 'rgba(0,0,0,.85)'
        c.strokeText(p.text, x, y)
        c.fillStyle = p.color ?? '#fff'
        c.fillText(p.text, x, y)
      } else if (p.digits !== undefined) {
        drawDigits(c, p.digits, p.x, p.y)
      } else if (p.img) {
        c.drawImage(p.img, Math.round(p.x), Math.round(p.y))
      }
    }
    c.globalAlpha = 1
    this.def.drawFront?.(this, c)
  }
}
