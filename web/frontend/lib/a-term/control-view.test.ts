import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import {
  controlWheelAction,
  swallowQueryReplies,
  trackSgrMouse,
} from './control-view'

function terminal() {
  const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
  const replies: string[] = []
  term.onData((data) => replies.push(data))
  const write = (data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve))
  return { term, replies, write }
}

const QUERIES = [
  '\x1b[c', // DA1
  '\x1b[>c', // DA2
  '\x1b[=c', // DA3
  '\x1b[6n', // cursor position
  '\x1b[?6n',
  '\x1b[?2004$p', // DECRQM
  '\x1b[>q', // XTVERSION
  '\x1b[?u', // kitty keyboard
  '\x1bP$qm\x1b\\', // DECRQSS
  '\x1b]11;?\x07', // background colour
  '\x1b]4;1;?\x07',
]

describe('controlWheelAction', () => {
  it('gives the wheel to a mouse-tracking program, as SGR reports when it reads SGR', () => {
    const state = { mouseTracking: true, alternateScreen: true }
    expect(controlWheelAction({ ...state, sgrMouse: true })).toBe('forward-sgr')
    expect(controlWheelAction({ ...state, sgrMouse: false })).toBe(
      'xterm-report',
    )
  })

  it('keeps the wheel from a full-screen program without mouse tracking', () => {
    expect(
      controlWheelAction({
        mouseTracking: false,
        sgrMouse: false,
        alternateScreen: true,
      }),
    ).toBe('consume')
  })

  it('scrolls the terminal history otherwise', () => {
    expect(
      controlWheelAction({
        mouseTracking: false,
        sgrMouse: true,
        alternateScreen: false,
      }),
    ).toBe('scroll')
  })
})

describe('swallowQueryReplies', () => {
  it('xterm answers these queries on its own', async () => {
    const { replies, write } = terminal()
    for (const query of QUERIES) await write(query)
    expect(replies.length).toBeGreaterThan(5)
  })

  it('leaves the answers to tmux while active', async () => {
    const { term, replies, write } = terminal()
    swallowQueryReplies(term)
    for (const query of QUERIES) await write(query)
    expect(replies).toEqual([])
  })

  it('answers again once removed', async () => {
    const { term, replies, write } = terminal()
    const stop = swallowQueryReplies(term)
    await write('\x1b[c')
    expect(replies.length).toBe(0)
    stop()
    await write('\x1b[c')
    expect(replies.length).toBe(1)
  })

  it('still applies modes and text', async () => {
    const { term, write } = terminal()
    swallowQueryReplies(term)
    await write('\x1b[?1h\x1b]11;#102030\x07hello')
    expect(term.modes.applicationCursorKeysMode).toBe(true)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('hello')
  })
})

describe('trackSgrMouse', () => {
  it('follows DECSET 1006, including inside a combined mode list, and a reset', async () => {
    const { term, write } = terminal()
    const sgr = trackSgrMouse(term)
    expect(sgr.isSgr()).toBe(false)
    await write('\x1b[?1000;1006h')
    expect(sgr.isSgr()).toBe(true)
    await write('\x1b[?1006l')
    expect(sgr.isSgr()).toBe(false)
    await write('\x1b[?1006h\x1bc')
    expect(sgr.isSgr()).toBe(false)
    sgr.dispose()
  })
})
