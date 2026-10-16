import { describe, expect, it } from 'vitest'
import { layoutSnapshot } from './window-layout'

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
    const owner = { pid: 4242, startTime: '987654' }
    const out = layoutSnapshot([], [w('c', 500, 0), w('b', 0, 400), w('a', 0, 0)], owner)
    expect(out.windows.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(out.v).toBe(1)
  })

  it('names the writing process so a reader can tell a crash leftover from a live Aico', () => {
    const now = new Date('2026-10-15T20:00:00.000Z')
    const out = layoutSnapshot([], [], { pid: 4242, startTime: '987654' }, now)
    expect(out).toMatchObject({
      v: 1,
      pid: 4242,
      startTime: '987654',
      updatedAt: now.toISOString(),
    })
    expect(layoutSnapshot([], [], { pid: 4242, startTime: null }).startTime).toBeNull()
  })
})
