// A Compositor for tests of the modules that use one: rects, flags and the
// monitor list are plain state the test sets; placements are recorded and
// applied at once (or refused when `ready` is false).

import { vi } from 'vitest'
import {
  COMPOSITOR_UNAVAILABLE,
  type Compositor,
  type CompositorChange,
  type CompositorWindow,
  type MonitorInfo,
  monitorForRect,
  monitorNearPoint,
  type Point,
  type Rect,
} from './compositor'

const AREA: Rect = { x: 0, y: 0, width: 1024, height: 800 }

export const FAKE_MONITOR: MonitorInfo = {
  id: '1',
  primary: true,
  bounds: AREA,
  workArea: AREA,
  scale: 1,
}

type Win = Pick<CompositorWindow, 'id'>

export function fakeCompositor(
  o: { ready?: boolean; scale?: number; monitors?: MonitorInfo[]; cursor?: Point | null } = {},
) {
  const state = {
    ready: o.ready ?? true,
    scale: o.scale ?? 1,
    monitors: o.monitors ?? [FAKE_MONITOR],
    cursor: o.cursor === undefined ? { x: 10, y: 10 } : o.cursor,
  }
  const rects = new Map<number, Rect>()
  const minimized = new Set<number>()
  const maximized = new Set<number>()
  const focused = new Set<number>()
  const placing = new Set<number>()
  const listeners = new Set<(change: CompositorChange) => void>()
  const rectOf = (win: Win): Rect => rects.get(win.id) ?? { x: 0, y: 0, width: 0, height: 0 }

  const place = vi.fn(async (win: Win, rect: Rect) => {
    if (!state.ready) return { ok: false as const, error: COMPOSITOR_UNAVAILABLE }
    rects.set(win.id, rect)
    return { ok: true as const }
  })
  const prepare = vi.fn(async (win: Win, rect: Rect) => {
    rects.set(win.id, rect)
    placing.add(win.id)
  })
  const raise = vi.fn(async () => {})
  const attach = vi.fn()
  const detach = vi.fn()

  const compositor: Compositor = {
    backend: 'bridge',
    ready: () => state.ready,
    start: () => {},
    stop: () => {},
    attach: attach as never,
    detach,
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    bounds: (win) => rectOf(win),
    isMinimized: (win) => minimized.has(win.id),
    isMaximized: (win) => maximized.has(win.id),
    isFocused: (win) => focused.has(win.id),
    isPlacing: (win) => placing.has(win.id),
    monitors: () => (state.ready ? state.monitors : []),
    monitorFor: (rect) => (state.ready ? monitorForRect(state.monitors, rect) : undefined),
    monitorNear: (point) => (state.ready ? monitorNearPoint(state.monitors, point) : undefined),
    scale: () => state.scale,
    tolerance: () => 1,
    toClient: (win, p) => {
      const r = rectOf(win)
      return { x: (p.x - r.x) / state.scale, y: (p.y - r.y) / state.scale }
    },
    fromClient: (win, p) => {
      const r = rectOf(win)
      return { x: r.x + p.x * state.scale, y: r.y + p.y * state.scale }
    },
    cursor: async () => state.cursor,
    prepare: prepare as never,
    place: place as never,
    raise: raise as never,
  }

  return {
    compositor,
    state,
    rects,
    minimized,
    maximized,
    focused,
    placing,
    place,
    prepare,
    raise,
    attach,
    detach,
    emit: (change: CompositorChange) => {
      for (const fn of [...listeners]) fn(change)
    },
  }
}
