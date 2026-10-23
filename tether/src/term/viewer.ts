// A WebSocket viewer of a control-mode link: the frames the web terminal
// speaks, and the credit loop that keeps a slow viewer from growing memory.
//
// Frames are one type byte and a payload, both directions:
//   0x01 data     server->viewer: pane text (UTF-8); viewer->server: typed input
//   0x02 control  JSON (`{__ctrl: true, …}`): resize/claim, paste, refresh, notices

import type { ControlTerminal } from './control'

export const FRAME_DATA = 0x01
export const FRAME_CONTROL = 0x02

export type ViewerFrame =
  | { kind: 'data'; text: string }
  | { kind: 'control'; message: Record<string, unknown> }

export function dataFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const frame = Buffer.allocUnsafe(body.length + 1)
  frame[0] = FRAME_DATA
  body.copy(frame, 1)
  return frame
}

export function controlFrame(message: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.of(FRAME_CONTROL), Buffer.from(JSON.stringify(message), 'utf8')])
}

/** A frame from the viewer, or null for anything malformed (dropped, not fatal). */
export function parseViewerFrame(frame: Buffer): ViewerFrame | null {
  if (frame.length < 1) return null
  const body = frame.subarray(1).toString('utf8')
  if (frame[0] === FRAME_DATA) return { kind: 'data', text: body }
  if (frame[0] !== FRAME_CONTROL) return null
  try {
    const message = JSON.parse(body) as unknown
    return message && typeof message === 'object' && !Array.isArray(message)
      ? { kind: 'control', message: message as Record<string, unknown> }
      : null
  } catch {
    return null
  }
}

/** What the server needs of a viewer's socket (`ws` WebSocket fits). */
export interface ViewerSocket {
  /** `done` runs once the frame has been handed to the network (ws's send callback). */
  send(frame: Buffer, done: (error?: Error) => void): void
  close(code?: number, reason?: string): void
}

/** Credit a WebSocket viewer gets: text outstanding before the link stops reading tmux. */
export const VIEWER_CREDIT_BYTES = 1 << 20

/**
 * Stream a link to a viewer's socket as data frames. The link must have been
 * made with `creditBytes`: each frame's text is credited back once the socket
 * has sent it, so a viewer on a slow connection holds at most that much here
 * and tmux pauses the pane for it instead (the link then reseeds). The socket
 * closes when the link exits. Returns a detach for when the socket closes first.
 */
export function streamToViewer(
  link: Pick<ControlTerminal, 'onData' | 'onExit' | 'delivered' | 'kill'>,
  socket: ViewerSocket,
): () => void {
  let open = true
  link.onData((text) => {
    if (!open) return
    socket.send(dataFrame(text), () => link.delivered(text.length))
  })
  link.onExit(() => {
    if (open) socket.close(1000, 'session ended')
    open = false
  })
  return () => {
    open = false
    link.kill()
  }
}
