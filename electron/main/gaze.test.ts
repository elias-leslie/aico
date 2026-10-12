import { describe, expect, it } from 'vitest'
import {
  type Face,
  fillFreedSpace,
  layoutSnapshot,
  neighbours,
  pickScene,
  placeNewWindow,
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

describe('placeNewWindow', () => {
  const area = { x: 0, y: 0, width: 3277, height: 1344 }
  const col = (id: string, x: number, y: number, width = 928, height = 448) => ({
    id,
    bounds: { x, y, width, height },
  })

  it('fills the free gap when there is room', () => {
    // Left column full; everything right of it free.
    const p = placeNewWindow(area, [col('a', 0, 0), col('b', 0, 448), col('c', 0, 896)])
    expect(p.resize).toBeUndefined()
    expect(p.bounds).toEqual({ x: 928, y: 0, width: 3277 - 928, height: 1344 })
  })

  it('splits the biggest window when the screen is full', () => {
    // The owner's grid: three left, one big centre, three right.
    const wins = [
      col('l1', 0, 0),
      col('l2', 0, 448),
      col('l3', 0, 896),
      col('mid', 924, 0, 1428, 1344),
      col('r1', 2348, 0, 929),
      col('r2', 2348, 448, 929),
      col('r3', 2348, 896, 929),
    ]
    const p = placeNewWindow(area, wins)
    expect(p.resize?.id).toBe('mid')
    expect(p.resize?.bounds).toEqual({ x: 924, y: 0, width: 1428, height: 672 })
    expect(p.bounds).toEqual({ x: 924, y: 672, width: 1428, height: 672 })
  })

  it('splits a wide window side by side', () => {
    const p = placeNewWindow(area, [col('only', 0, 0, 3277, 1344)])
    expect(p.resize?.bounds.width).toBe(1638)
    expect(p.bounds).toEqual({ x: 1638, y: 0, width: 1639, height: 1344 })
  })

  it('gives the first window the whole work area', () => {
    const p = placeNewWindow(area, [])
    expect(p.bounds).toEqual(area)
  })
})

describe('fillFreedSpace', () => {
  const w = (id: string, x: number, y: number, width: number, height: number) => ({
    id,
    bounds: { x, y, width, height },
  })

  it('undoes a split: the other half takes the space back', () => {
    const out = fillFreedSpace({ x: 924, y: 672, width: 1428, height: 672 }, [
      w('top', 924, 0, 1428, 672),
      w('left', 0, 0, 928, 1344),
    ])
    expect(out).toEqual([{ id: 'top', bounds: { x: 924, y: 0, width: 1428, height: 1344 } }])
  })

  it('a column grows to fill a closed column, even with hand-tiled overlaps', () => {
    // Middle window closes; the right column (three stacked, 4px overlap)
    // and the left column both border it; one side needs three, so does the
    // other — either is fine, but every window on that side grows together.
    const out = fillFreedSpace({ x: 924, y: 0, width: 1428, height: 1344 }, [
      w('l1', 0, 0, 928, 448),
      w('l2', 0, 448, 928, 448),
      w('l3', 0, 896, 928, 448),
      w('r1', 2348, 0, 929, 448),
      w('r2', 2348, 448, 929, 448),
      w('r3', 2348, 896, 929, 448),
    ])
    expect(out).toHaveLength(3)
    const ids = out.map((o) => o.id)
    expect(ids.every((id) => id.startsWith('l')) || ids.every((id) => id.startsWith('r'))).toBe(
      true,
    )
  })

  it('leaves things alone when no side is fully covered', () => {
    const out = fillFreedSpace({ x: 0, y: 0, width: 500, height: 500 }, [
      w('half', 500, 0, 500, 250),
    ])
    expect(out).toEqual([])
  })
})
