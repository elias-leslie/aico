// Tiling: a fixed arrangement per window count, on the owner's ultrawide.
// Columns match their Tiling Shell layout (28.2% | 43.6% | 28.2%). The centre
// stays open for browsing whenever the count is even; an odd count puts one
// window there. Side columns stack up to SIDE_MAX windows each; beyond that
// the extras stack in the centre.
//   1: centre   2: left, right   3: left, centre, right   4: four corners
//   5: corners + centre   6: three per side   7: three per side + centre
//
// Coordinator windows (sessions that launched lanes) own the centre instead,
// at full height, several splitting it top to bottom. Every other window goes
// to the side columns, split evenly with the left taking the extra one. A
// column holds as many windows as fit at MIN_TILE_HEIGHT; past that a side
// splits into more columns towards the screen edge, the inner column taking
// the extra one. Coordinators that no longer fit the centre join the sides.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const SIDE_FRACTION = 0.2822265625
export const SIDE_MAX = 4
export const MIN_TILE_HEIGHT = 240

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
  const perColumn = Math.max(1, Math.floor(area.height / MIN_TILE_HEIGHT))
  const lead = Math.min(perColumn, Math.max(0, coordinators), n)
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
  const sideColumns = (x: number, count: number, innerAtRight: boolean): Rect[] => {
    const columns = Math.ceil(count / perColumn)
    const out: Rect[] = []
    for (let i = 0; i < columns; i++) {
      // Column i counted from the centre outwards.
      const k = innerAtRight ? columns - 1 - i : i
      const left = x + Math.round((side * k) / columns)
      const right = x + Math.round((side * (k + 1)) / columns)
      const rows = Math.floor(count / columns) + (i < count % columns ? 1 : 0)
      out.push(...stack(left, right - left, area, rows))
    }
    return out
  }
  return {
    coordinator: stack(centreX, rightX - centreX, area, lead),
    other: [
      ...sideColumns(area.x, Math.ceil(rest / 2), true),
      ...sideColumns(rightX, Math.floor(rest / 2), false),
    ],
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

function centreOf(r: Rect): { x: number; y: number } {
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
