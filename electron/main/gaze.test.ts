import { describe, expect, it } from 'vitest'
import {
  allLookAt,
  arrange,
  type Face,
  layoutSnapshot,
  neighbours,
  pickScene,
  tileSlots,
} from './gaze'

// Three tiled windows in a column on the left, one big one to their right.
const faces: Face[] = [
  { winId: 1, eye: { x: 36, y: 16 }, focused: false },
  { winId: 2, eye: { x: 36, y: 464 }, focused: false },
  { winId: 3, eye: { x: 36, y: 912 }, focused: false },
  { winId: 4, eye: { x: 960, y: 16 }, focused: true },
]

const seq = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

describe('neighbours', () => {
  it('orders the other windows nearest first', () => {
    const from = faces[0] as Face
    expect(neighbours(from, faces).map((f) => f.winId)).toEqual([2, 3, 4])
  })
})

describe('pickScene', () => {
  it('does nothing with a single window', () => {
    expect(pickScene(faces.slice(0, 1), Math.random)).toEqual([])
  })

  it('has a pair look at each other, the second a beat later', () => {
    // 0.99 skips the group scene; 0 picks window 1; 0 picks its nearest (2).
    const scene = pickScene(faces, seq(0.99, 0, 0))
    expect(scene).toHaveLength(2)
    const [a, b] = scene
    expect(a?.winId).toBe(1)
    expect(a?.target).toEqual(faces[1]?.eye)
    expect(b?.winId).toBe(2)
    expect(b?.target).toEqual(faces[0]?.eye)
    expect(b?.delay ?? 0).toBeGreaterThan(a?.delay ?? 0)
  })

  it('turns everyone to the focused window, which looks back at the nearest', () => {
    const scene = pickScene(faces, seq(0, 0))
    const lookers = scene.filter((g) => g.winId !== 4)
    expect(lookers.map((g) => g.winId).sort()).toEqual([1, 2, 3])
    for (const g of lookers) expect(g.target).toEqual(faces[3]?.eye)
    const back = scene.find((g) => g.winId === 4)
    expect(back?.target).toEqual(faces[0]?.eye)
    expect(back?.delay ?? 0).toBeGreaterThan(Math.max(...lookers.map((g) => g.delay)))
  })
})

describe('allLookAt', () => {
  it('turns every other window to a waiting one, which keeps its own look', () => {
    const waiting = faces[1] as Face
    const scene = allLookAt(waiting, faces, seq(0), false)
    expect(scene.map((g) => g.winId).sort()).toEqual([1, 3, 4])
    for (const g of scene) expect(g.target).toEqual(waiting.eye)
  })
})

describe('layoutSnapshot', () => {
  it('lists windows column by column, top to bottom', () => {
    const w = (id: string, x: number, y: number) => ({
      id,
      name: id,
      bounds: { x, y, width: 100, height: 100 },
      displayId: '1',
      focused: false,
      visible: true,
      minimized: false,
      maximized: false,
    })
    const out = layoutSnapshot([], [w('c', 500, 0), w('b', 0, 400), w('a', 0, 0)])
    expect(out.windows.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(out.v).toBe(1)
  })
})

describe('tileSlots', () => {
  const area = { x: 0, y: 0, width: 3277, height: 1344 }
  const side = Math.round(3277 * 0.2822265625)
  const where = (n: number) =>
    tileSlots(n, area).map((r) => `${r.x === 0 ? 'L' : r.x === side ? 'C' : 'R'}${r.height}`)

  it('follows the owner layout for 1 to 7 windows', () => {
    expect(where(1)).toEqual(['C1344'])
    expect(where(2)).toEqual(['L1344', 'R1344'])
    expect(where(3)).toEqual(['L1344', 'C1344', 'R1344'])
    expect(where(4)).toEqual(['L672', 'L672', 'R672', 'R672'])
    expect(where(5)).toEqual(['L672', 'L672', 'C1344', 'R672', 'R672'])
    expect(where(6)).toEqual(['L448', 'L448', 'L448', 'R448', 'R448', 'R448'])
    expect(where(7)).toEqual(['L448', 'L448', 'L448', 'C1344', 'R448', 'R448', 'R448'])
  })

  it('tiles the work area exactly, columns abutting', () => {
    const slots = tileSlots(7, area)
    const centre = slots[3]
    expect(centre?.x).toBe(side)
    expect((centre?.x ?? 0) + (centre?.width ?? 0)).toBe(3277 - side)
    expect(slots.at(-1)?.y).toBe(896)
    expect((slots[2]?.y ?? 0) + (slots[2]?.height ?? 0)).toBe(1344)
  })

  it('stacks extras in the centre past four per side', () => {
    expect(where(10).filter((s) => s.startsWith('C'))).toHaveLength(2)
  })
})

describe('arrange', () => {
  const area = { x: 0, y: 0, width: 3277, height: 1344 }
  it('keeps windows on their side and gives the new one the free slot', () => {
    // Left and right windows; a third opens: it takes the centre.
    const out = arrange(
      area,
      [
        { id: 'r', bounds: { x: 2352, y: 0, width: 925, height: 1344 } },
        { id: 'l', bounds: { x: 0, y: 0, width: 925, height: 1344 } },
      ],
      'new',
    )
    const byId = Object.fromEntries(out.map((m) => [m.id, m.bounds.x]))
    expect(byId.l).toBe(0)
    expect(byId.new).toBe(925)
    expect(byId.r).toBe(3277 - 925)
  })

  it('closing the centre of three leaves left and right', () => {
    const out = arrange(area, [
      { id: 'l', bounds: { x: 0, y: 0, width: 925, height: 1344 } },
      { id: 'r', bounds: { x: 2352, y: 0, width: 925, height: 1344 } },
    ])
    expect(out.map((m) => [m.id, m.bounds.x])).toEqual([
      ['l', 0],
      ['r', 2352],
    ])
  })
})
