import { describe, expect, it, vi } from 'vitest'
import {
  controlFrame,
  dataFrame,
  FRAME_CONTROL,
  FRAME_DATA,
  parseViewerFrame,
  streamToViewer,
} from './viewer'

describe('viewer frames', () => {
  it('prefixes pane text and control JSON with their type byte', () => {
    expect([...dataFrame('é')]).toEqual([FRAME_DATA, 0xc3, 0xa9])
    const frame = controlFrame({ __ctrl: true, transport: 'control' })
    expect(frame[0]).toBe(FRAME_CONTROL)
    expect(JSON.parse(frame.subarray(1).toString())).toEqual({ __ctrl: true, transport: 'control' })
  })

  it('reads input and control frames from the viewer and drops malformed ones', () => {
    expect(parseViewerFrame(dataFrame('ls\r'))).toEqual({ kind: 'data', text: 'ls\r' })
    expect(parseViewerFrame(controlFrame({ __ctrl: true, paste: 'a' }))).toEqual({
      kind: 'control',
      message: { __ctrl: true, paste: 'a' },
    })
    expect(parseViewerFrame(Buffer.alloc(0))).toBeNull()
    expect(parseViewerFrame(Buffer.of(0x07, 0x61))).toBeNull()
    expect(
      parseViewerFrame(Buffer.concat([Buffer.of(FRAME_CONTROL), Buffer.from('[1]')])),
    ).toBeNull()
    expect(parseViewerFrame(Buffer.concat([Buffer.of(FRAME_CONTROL), Buffer.from('{')]))).toBeNull()
  })
})

describe('streamToViewer', () => {
  function fakeLink() {
    const data: ((text: string) => void)[] = []
    const exits: (() => void)[] = []
    return {
      onData: (fn: (text: string) => void) => data.push(fn),
      onExit: (fn: () => void) => exits.push(fn),
      delivered: vi.fn(),
      kill: vi.fn(),
      emit: (text: string) => {
        for (const fn of data) fn(text)
      },
      exit: () => {
        for (const fn of exits) fn()
      },
    }
  }

  it('credits each frame back once the socket has sent it', () => {
    const link = fakeLink()
    const sends: (() => void)[] = []
    const socket = {
      send: vi.fn((_f: Buffer, done: () => void) => sends.push(done)),
      close: vi.fn(),
    }
    streamToViewer(link, socket)
    link.emit('hello')
    link.emit('❯')
    expect(socket.send.mock.calls.map(([frame]) => frame.subarray(1).toString())).toEqual([
      'hello',
      '❯',
    ])
    expect(link.delivered).not.toHaveBeenCalled()
    for (const done of sends) done()
    expect(link.delivered.mock.calls).toEqual([[5], [1]])
  })

  it('closes the socket when the link exits, and kills the link when the socket goes first', () => {
    const link = fakeLink()
    const socket = { send: vi.fn(), close: vi.fn() }
    const detach = streamToViewer(link, socket)
    detach()
    link.emit('late')
    expect(socket.send).not.toHaveBeenCalled()
    expect(link.kill).toHaveBeenCalled()
    link.exit()
    expect(socket.close).not.toHaveBeenCalled()
    const other = fakeLink()
    streamToViewer(other, socket)
    other.exit()
    expect(socket.close).toHaveBeenCalledWith(1000, 'session ended')
  })
})
