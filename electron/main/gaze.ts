// The eyes across windows.
//
// Tiled Aico windows are a Brady Bunch grid: every so often two neighbours turn
// to look at each other, or the whole grid turns to look at one window. Main
// owns this because only main knows where every window is; each renderer just
// aims its eyes at the screen point it is sent (see eyes.ts lookAtPeer).

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
