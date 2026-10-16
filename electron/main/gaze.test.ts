import { describe, expect, it } from 'vitest'
import { allLookAt, type Face, neighbours, pickScene } from './gaze'

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
