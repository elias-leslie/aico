import { describe, expect, it } from 'vitest'
import {
  allLookAt,
  arrange,
  type Face,
  layoutSnapshot,
  neighbours,
  pickScene,
  tileGroups,
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
      coordinator: false,
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

describe('tileGroups with coordinators', () => {
  const area = { x: 0, y: 0, width: 3277, height: 1344 }
  const side = Math.round(3277 * 0.2822265625)
  const tag = (r: { x: number; height: number }) =>
    `${r.x === 0 ? 'L' : r.x === side ? 'C' : 'R'}${r.height}`
  const groups = (n: number, c: number) => {
    const g = tileGroups(n, area, c)
    return { lead: g.coordinator.map(tag), other: g.other.map(tag) }
  }

  it('leaves every layout unchanged without coordinators', () => {
    for (let n = 1; n <= 10; n++) {
      expect(tileGroups(n, area, 0).coordinator).toEqual([])
      expect(tileSlots(n, area, 0)).toEqual(tileSlots(n, area))
    }
  })

  it('stacks one to three coordinators in the centre', () => {
    expect(groups(1, 1)).toEqual({ lead: ['C1344'], other: [] })
    expect(groups(2, 2)).toEqual({ lead: ['C672', 'C672'], other: [] })
    expect(groups(3, 3)).toEqual({ lead: ['C448', 'C448', 'C448'], other: [] })
    const three = tileGroups(3, area, 3).coordinator
    expect(three.map((r) => r.y)).toEqual([0, 448, 896])
  })

  it('splits the others between the sides, the left taking the extra', () => {
    expect(groups(2, 1)).toEqual({ lead: ['C1344'], other: ['L1344'] })
    expect(groups(3, 1)).toEqual({ lead: ['C1344'], other: ['L1344', 'R1344'] })
    // One coordinator and three others: left two stacked, right one full height.
    expect(groups(4, 1)).toEqual({ lead: ['C1344'], other: ['L672', 'L672', 'R1344'] })
    expect(groups(5, 1)).toEqual({ lead: ['C1344'], other: ['L672', 'L672', 'R672', 'R672'] })
    expect(groups(6, 1)).toEqual({
      lead: ['C1344'],
      other: ['L448', 'L448', 'L448', 'R672', 'R672'],
    })
    expect(groups(4, 2)).toEqual({ lead: ['C672', 'C672'], other: ['L1344', 'R1344'] })
    expect(groups(5, 2)).toEqual({ lead: ['C672', 'C672'], other: ['L672', 'L672', 'R1344'] })
    expect(groups(4, 3)).toEqual({ lead: ['C448', 'C448', 'C448'], other: ['L1344'] })
    expect(groups(6, 3)).toEqual({
      lead: ['C448', 'C448', 'C448'],
      other: ['L672', 'L672', 'R1344'],
    })
  })

  it('keeps every coordinator that fits at 240px in the centre, the rest on the sides', () => {
    expect(groups(4, 4)).toEqual({ lead: ['C336', 'C336', 'C336', 'C336'], other: [] })
    const five = tileGroups(6, area, 6)
    expect(five.coordinator).toHaveLength(5)
    expect(five.coordinator.every((r) => r.height >= 240)).toBe(true)
    expect(five.other.map(tag)).toEqual(['L1344'])
  })

  it('fills the sides evenly and adds columns towards the edges past five per column', () => {
    // 1 coordinator + 10 others: five per side, one column each.
    const ten = groups(11, 1)
    expect(ten.lead).toEqual(['C1344'])
    expect(ten.other.filter((t) => t.startsWith('L'))).toHaveLength(5)
    expect(ten.other.filter((t) => t.startsWith('R'))).toHaveLength(5)
    // 2 coordinators + 12 others: six per side, two columns of three.
    const g = tileGroups(14, area, 2)
    expect(g.coordinator.map((r) => [r.x, r.y, r.width, r.height])).toEqual([
      [side, 0, 3277 - 2 * side, 672],
      [side, 672, 3277 - 2 * side, 672],
    ])
    const columns = (slots: { x: number; width: number }[]) =>
      [...new Set(slots.map((r) => `${r.x}+${r.width}`))].sort()
    const half = Math.round(side / 2)
    const right = 3277 - side
    expect(columns(g.other.filter((r) => r.x < side))).toEqual(
      [`0+${half}`, `${half}+${side - half}`].sort(),
    )
    expect(columns(g.other.filter((r) => r.x >= right))).toEqual(
      [`${right}+${half}`, `${right + half}+${side - half}`].sort(),
    )
    expect(g.other.every((r) => r.height === 448)).toBe(true)
    // 1 coordinator + 11 others: six left (3+3), five right (one column).
    const odd = tileGroups(12, area, 1).other
    expect(odd.filter((r) => r.x < side)).toHaveLength(6)
    expect(odd.filter((r) => r.x >= right).every((r) => r.width === side)).toBe(true)
  })

  it('never stacks a window shorter than 240px or over the centre, for 1-2 coordinators and 0-12 others', () => {
    for (const c of [1, 2]) {
      for (let others = 0; others <= 12; others++) {
        const g = tileGroups(c + others, area, c)
        expect(g.coordinator).toHaveLength(c)
        expect(g.other).toHaveLength(others)
        expect(g.other.every((r) => r.x + r.width <= side || r.x >= 3277 - side)).toBe(true)
        expect([...g.coordinator, ...g.other].every((r) => r.height >= 240)).toBe(true)
      }
    }
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

  it('moves a coordinator to the centre and its neighbours to the sides', () => {
    // Today's 2+1+2 layout; the left-bottom window becomes a coordinator.
    const out = arrange(area, [
      { id: 'a', bounds: { x: 0, y: 0, width: 925, height: 672 } },
      { id: 'lead', bounds: { x: 0, y: 672, width: 925, height: 672 }, coordinator: true },
      { id: 'c', bounds: { x: 925, y: 0, width: 1427, height: 1344 } },
      { id: 'd', bounds: { x: 2352, y: 0, width: 925, height: 672 } },
      { id: 'e', bounds: { x: 2352, y: 672, width: 925, height: 672 } },
    ])
    const byId = Object.fromEntries(out.map((m) => [m.id, m.bounds]))
    expect(byId.lead).toEqual({ x: 925, y: 0, width: 1427, height: 1344 })
    expect(byId.a).toEqual({ x: 0, y: 0, width: 925, height: 672 })
    expect(byId.d).toEqual({ x: 2352, y: 0, width: 925, height: 672 })
    expect(byId.e).toEqual({ x: 2352, y: 672, width: 925, height: 672 })
    // c is pushed out of the centre to the free left slot.
    expect(byId.c).toEqual({ x: 0, y: 672, width: 925, height: 672 })
  })

  it('tiles a new window on the sides, never over a coordinator', () => {
    const out = arrange(
      area,
      [
        { id: 'lead', bounds: { x: 925, y: 0, width: 1427, height: 1344 }, coordinator: true },
        { id: 'l', bounds: { x: 0, y: 0, width: 925, height: 1344 } },
      ],
      'new',
    )
    const byId = Object.fromEntries(out.map((m) => [m.id, m.bounds.x]))
    expect(byId).toEqual({ lead: 925, l: 0, new: 2352 })
  })

  it('keeps stacked coordinators in their order', () => {
    const out = arrange(area, [
      { id: 'low', bounds: { x: 925, y: 700, width: 1427, height: 644 }, coordinator: true },
      { id: 'high', bounds: { x: 925, y: 0, width: 1427, height: 700 }, coordinator: true },
    ])
    const byId = Object.fromEntries(out.map((m) => [m.id, m.bounds.y]))
    expect(byId).toEqual({ low: 672, high: 0 })
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
