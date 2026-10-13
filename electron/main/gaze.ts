// The eyes across windows, and the window layout agents read.
//
// Tiled Aico windows are a Brady Bunch grid: every so often two neighbours turn
// to look at each other, or the whole grid turns to look at one window. Main
// owns this because only main knows where every window is; each renderer just
// aims its eyes at the screen point it is sent (see eyes.ts lookAtPeer).
//
// The same picture is written to $XDG_RUNTIME_DIR/aico/layout.json so agents
// can see how the windows are arranged before moving them with
// `st aico widget position`.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** One visible window as the director sees it: where its eyes are on screen. */
export interface Face {
  winId: number
  eye: Point
  focused: boolean
}

/** Tell window `winId` to look at screen point `target` after `delay` ms and
 * hold the look for `hold` ms. */
export interface Glance {
  winId: number
  target: Point
  delay: number
  hold: number
}

/** Seconds between scenes. Rare enough to stay a surprise. */
export const SCENE_EVERY_MS: [number, number] = [20_000, 45_000]

/** Where the eyes sit in a window when it has not said (client px). */
export const DEFAULT_EYE_ANCHOR: Point = { x: 36, y: 16 }

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Faces ordered nearest first from `from`, excluding it. */
export function neighbours(from: Face, faces: Face[]): Face[] {
  return faces
    .filter((f) => f.winId !== from.winId)
    .sort((a, b) => distance(from.eye, a.eye) - distance(from.eye, b.eye))
}

/** Everyone turns to `star`, nearest first; it looks back at the nearest.
 * Also played on purpose at a window that has waited on the owner too long
 * (attention.ts `urgent`), with `answer` false: that one keeps its own look. */
export function allLookAt(star: Face, faces: Face[], rand: () => number, answer = true): Glance[] {
  const others = neighbours(star, faces)
  const glances: Glance[] = others.map((f, i) => ({
    winId: f.winId,
    target: star.eye,
    delay: i * 140 + Math.floor(rand() * 120),
    hold: 1700,
  }))
  const nearest = others[0]
  if (answer && nearest) {
    const last = glances.reduce((m, g) => Math.max(m, g.delay), 0)
    glances.push({ winId: star.winId, target: nearest.eye, delay: last + 250, hold: 1100 })
  }
  return glances
}

/**
 * Pick one scene. `rand` is a source of [0, 1) numbers (Math.random in use).
 * - pair: a window glances at a near neighbour; a beat later it looks back.
 * - all (three or more windows): everyone turns to one window — the focused
 *   one if any — and it looks back at whoever is nearest.
 */
export function pickScene(faces: Face[], rand: () => number): Glance[] {
  if (faces.length < 2) return []
  if (faces.length >= 3 && rand() < 0.3) {
    const star = faces.find((f) => f.focused) ?? faces[Math.floor(rand() * faces.length)]
    return star ? allLookAt(star, faces, rand) : []
  }
  const a = faces[Math.floor(rand() * faces.length)]
  if (!a) return []
  // One of the two nearest, so a tidy grid does not replay the same pair.
  const near = neighbours(a, faces).slice(0, 2)
  const b = near[Math.floor(rand() * near.length)]
  if (!b) return []
  return [
    { winId: a.winId, target: b.eye, delay: 0, hold: 1500 },
    { winId: b.winId, target: a.eye, delay: 450, hold: 1050 },
  ]
}

export interface LayoutWindow {
  /** Tether session id; what `st aico widget position --widget-id` takes. */
  id: string
  name: string
  bounds: Rect
  displayId: string
  focused: boolean
  visible: boolean
  minimized: boolean
  maximized: boolean
  /** Marked as a coordinator: tiles in the centre column. */
  coordinator: boolean
}

export interface LayoutDisplay {
  id: string
  primary: boolean
  bounds: Rect
  /** Usable area (panels excluded); arrange windows inside this. */
  workArea: Rect
  scaleFactor: number
}

export interface Layout {
  v: 1
  updatedAt: string
  displays: LayoutDisplay[]
  windows: LayoutWindow[]
}

export function layoutSnapshot(
  displays: LayoutDisplay[],
  windows: LayoutWindow[],
  now = new Date(),
): Layout {
  const order = (w: LayoutWindow): [number, number] => [w.bounds.y, w.bounds.x]
  const sorted = [...windows].sort((p, q) => {
    const [py, px] = order(p)
    const [qy, qx] = order(q)
    return px - qx || py - qy
  })
  return { v: 1, updatedAt: now.toISOString(), displays, windows: sorted }
}

// ---------------------------------------------------------------------------
// Tiling: a fixed arrangement per window count, on the owner's ultrawide.
// Columns match their Tiling Shell layout (28.2% | 43.6% | 28.2%). The centre
// stays open for browsing whenever the count is even; an odd count puts one
// window there. Side columns stack up to SIDE_MAX windows each; beyond that
// the extras stack in the centre.
//   1: centre   2: left, right   3: left, centre, right   4: four corners
//   5: corners + centre   6: three per side   7: three per side + centre
//
// Coordinator windows (sessions that launched lanes) own the centre instead:
// up to CENTRE_MAX of them stack there top to bottom, and every other window,
// including coordinators past CENTRE_MAX, splits between the sides, the left
// taking the extra one. A side holding one window gives it the full height.
// Past SIDE_MAX per side the extras stack in the centre below the coordinators.

export const SIDE_FRACTION = 0.2822265625
export const SIDE_MAX = 4
export const CENTRE_MAX = 3

function stack(x: number, width: number, area: Rect, count: number): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i < count; i++) {
    const top = area.y + Math.round((area.height * i) / count)
    const bottom = area.y + Math.round((area.height * (i + 1)) / count)
    out.push({ x, y: top, width, height: bottom - top })
  }
  return out
}

/** Slots for `n` windows, `coordinators` of them coordinators. */
export interface TileGroups {
  /** Centre slots for coordinators, top to bottom. */
  coordinator: Rect[]
  /** Slots for every other window: left top to bottom, centre overflow, right. */
  other: Rect[]
}

export function tileGroups(n: number, area: Rect, coordinators = 0): TileGroups {
  if (n <= 0) return { coordinator: [], other: [] }
  const side = Math.round(area.width * SIDE_FRACTION)
  const rightX = area.x + area.width - side
  const centreX = area.x + side
  const column = (left: number, centre: number, right: number) => ({
    left: stack(area.x, side, area, left),
    centre: stack(centreX, rightX - centreX, area, centre),
    right: stack(rightX, side, area, right),
  })
  const lead = Math.min(CENTRE_MAX, Math.max(0, coordinators), n)
  if (lead === 0) {
    let perSide = Math.min(SIDE_MAX, Math.floor(n / 2))
    let centre = n - perSide * 2
    if (n === 1) {
      perSide = 0
      centre = 1
    }
    const c = column(perSide, centre, perSide)
    return { coordinator: [], other: [...c.left, ...c.centre, ...c.right] }
  }
  const rest = n - lead
  const left = Math.min(SIDE_MAX, Math.ceil(rest / 2))
  const right = Math.min(SIDE_MAX, Math.floor(rest / 2))
  const c = column(left, n - left - right, right)
  return {
    coordinator: c.centre.slice(0, lead),
    other: [...c.left, ...c.centre.slice(lead), ...c.right],
  }
}

/** Slots for `n` windows, left column top to bottom, then centre, then right. */
export function tileSlots(n: number, area: Rect, coordinators = 0): Rect[] {
  const groups = tileGroups(n, area, coordinators)
  return [...groups.coordinator, ...groups.other].sort((p, q) => p.x - q.x || p.y - q.y)
}

export interface Move {
  id: string
  bounds: Rect
  coordinator?: boolean
}

function centreOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/** Nearest-first matching: each window takes the free slot closest to it. */
function assign(windows: Move[], slots: Rect[]): Map<Move, Rect> {
  const pairs: { w: number; s: number; d: number }[] = []
  windows.forEach((win, w) => {
    const c = centreOf(win.bounds)
    slots.forEach((slot, s) => {
      const t = centreOf(slot)
      pairs.push({ w, s, d: Math.hypot(c.x - t.x, c.y - t.y) })
    })
  })
  pairs.sort((a, b) => a.d - b.d)
  const slotTaken = new Set<number>()
  const placed = new Map<Move, Rect>()
  for (const { w, s } of pairs) {
    const win = windows[w] as Move
    if (placed.has(win) || slotTaken.has(s)) continue
    placed.set(win, slots[s] as Rect)
    slotTaken.add(s)
  }
  return placed
}

/**
 * Lay out `windows` plus, optionally, one new window (id `newId`) in the slots
 * for their count. Coordinators take the centre slots first; each window then
 * takes the free slot of its group nearest to where it is now, so a column
 * keeps its windows; the new window gets what is left.
 */
export function arrange(area: Rect, windows: Move[], newId?: string): Move[] {
  const n = windows.length + (newId ? 1 : 0)
  const leads = windows.filter((w) => w.coordinator)
  const groups = tileGroups(n, area, leads.length)
  const placed = assign(leads, groups.coordinator)
  const others = windows.filter((w) => !placed.has(w))
  for (const [win, slot] of assign(others, groups.other)) placed.set(win, slot)
  const out: Move[] = windows.map((win) => ({
    id: win.id,
    bounds: placed.get(win) ?? ((groups.other[0] ?? groups.coordinator[0]) as Rect),
  }))
  if (newId) {
    const taken = new Set(placed.values())
    const free = groups.other.find((slot) => !taken.has(slot))
    if (free) out.push({ id: newId, bounds: free })
  }
  return out
}
