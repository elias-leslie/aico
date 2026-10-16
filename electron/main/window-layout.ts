// The window layout agents read: the picture main has of every Aico window is
// written to $XDG_RUNTIME_DIR/aico/layout.json so agents can see how the
// windows are arranged before moving them with `st aico widget position`.

import type { Rect } from './tiling'

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

/** The Aico process that wrote the layout. */
export interface LayoutOwner {
  pid: number
  /** `/proc/<pid>/stat` field 22 as printed (see process-identity.ts); null
   * if procfs couldn't be read. A file whose pid is gone, or whose pid now
   * has another start time, was left by a crash: no Aico is running. */
  startTime: string | null
}

export interface Layout extends LayoutOwner {
  v: 1
  updatedAt: string
  displays: LayoutDisplay[]
  windows: LayoutWindow[]
}

export function layoutSnapshot(
  displays: LayoutDisplay[],
  windows: LayoutWindow[],
  owner: LayoutOwner,
  now = new Date(),
): Layout {
  const order = (w: LayoutWindow): [number, number] => [w.bounds.y, w.bounds.x]
  const sorted = [...windows].sort((p, q) => {
    const [py, px] = order(p)
    const [qy, qx] = order(q)
    return px - qx || py - qy
  })
  return {
    v: 1,
    pid: owner.pid,
    startTime: owner.startTime,
    updatedAt: now.toISOString(),
    displays,
    windows: sorted,
  }
}
