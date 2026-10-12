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
    if (!star) return []
    const others = neighbours(star, faces)
    const glances: Glance[] = others.map((f, i) => ({
      winId: f.winId,
      target: star.eye,
      delay: i * 140 + Math.floor(rand() * 120),
      hold: 1700,
    }))
    const nearest = others[0]
    if (nearest) {
      const last = glances.reduce((m, g) => Math.max(m, g.delay), 0)
      glances.push({ winId: star.winId, target: nearest.eye, delay: last + 250, hold: 1100 })
    }
    return glances
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
// Tiling a new window into the existing arrangement instead of dropping it in
// the middle of the screen: take the biggest free gap if one is roomy enough;
// otherwise split the biggest window in half along its long side and take one
// half. Every other window stays exactly where the owner put it.

/** A gap smaller than this is not worth opening a window into. */
export const ROOMY: { width: number; height: number } = { width: 640, height: 400 }
/** Aico's minimum window size. */
export const MIN_SIZE: { width: number; height: number } = { width: 360, height: 240 }

export interface Placement {
  bounds: Rect
  /** A window to shrink so the new one fits beside it. */
  resize?: { id: string; bounds: Rect }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function clip(r: Rect, area: Rect): Rect | null {
  const x = Math.max(r.x, area.x)
  const y = Math.max(r.y, area.y)
  const right = Math.min(r.x + r.width, area.x + area.width)
  const bottom = Math.min(r.y + r.height, area.y + area.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** The largest empty rectangle in `area` whose edges line up with window and
 * work-area edges. Small inputs (a handful of windows), so brute force. */
export function largestGap(area: Rect, taken: Rect[]): Rect | null {
  const inside = taken.map((r) => clip(r, area)).filter((r): r is Rect => r !== null)
  const xs = [
    ...new Set([area.x, area.x + area.width, ...inside.flatMap((r) => [r.x, r.x + r.width])]),
  ].sort((a, b) => a - b)
  const ys = [
    ...new Set([area.y, area.y + area.height, ...inside.flatMap((r) => [r.y, r.y + r.height])]),
  ].sort((a, b) => a - b)
  let best: Rect | null = null
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++)
      for (let k = 0; k < ys.length; k++)
        for (let l = k + 1; l < ys.length; l++) {
          const r = {
            x: xs[i] as number,
            y: ys[k] as number,
            width: (xs[j] as number) - (xs[i] as number),
            height: (ys[l] as number) - (ys[k] as number),
          }
          if (best && r.width * r.height <= best.width * best.height) continue
          if (inside.some((t) => overlaps(r, t))) continue
          best = r
        }
  return best
}

export function placeNewWindow(
  area: Rect,
  windows: { id: string; bounds: Rect }[],
  roomy = ROOMY,
): Placement {
  const gap = largestGap(
    area,
    windows.map((w) => w.bounds),
  )
  if (gap && gap.width >= roomy.width && gap.height >= roomy.height) return { bounds: gap }
  const onArea = windows
    .map((w) => ({ id: w.id, bounds: clip(w.bounds, area) }))
    .filter((w): w is { id: string; bounds: Rect } => w.bounds !== null)
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
  const biggest = onArea[0]
  if (biggest) {
    const b = biggest.bounds
    // Terminals want width: only a clearly wide window splits left/right;
    // anything squarer splits top/bottom.
    if (b.width >= b.height * 1.5 && b.width >= MIN_SIZE.width * 2) {
      const left = Math.floor(b.width / 2)
      return {
        resize: { id: biggest.id, bounds: { ...b, width: left } },
        bounds: { ...b, x: b.x + left, width: b.width - left },
      }
    }
    if (b.height >= MIN_SIZE.height * 2) {
      const top = Math.floor(b.height / 2)
      return {
        resize: { id: biggest.id, bounds: { ...b, height: top } },
        bounds: { ...b, y: b.y + top, height: b.height - top },
      }
    }
  }
  // Nothing sensible to split (or no windows yet): a comfortable centred size.
  const width = Math.min(area.width, 900)
  const height = Math.min(area.height, 560)
  if (gap && gap.width >= MIN_SIZE.width && gap.height >= MIN_SIZE.height) return { bounds: gap }
  return {
    bounds: {
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    },
  }
}
