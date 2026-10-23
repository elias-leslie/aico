import { act, renderHook, waitFor } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useATermWriteQueue } from './use-a-term-write-queue'

vi.hoisted(() => {
  // These tests exercise the real terminal buffer without a canvas renderer.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

const terminals: Terminal[] = []

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose()
})

async function setup(scrollback = 100) {
  const term = new Terminal({ cols: 40, rows: 5, scrollback })
  terminals.push(term)
  await new Promise<void>((resolve) => {
    term.write(
      Array.from({ length: 30 }, (_, index) => `history ${index}`).join('\r\n'),
      resolve,
    )
  })
  const hook = renderHook(() =>
    useATermWriteQueue({
      aTermRef: { current: term },
      isVisibleRef: { current: true },
    }),
  )
  const write = async (data: string) => {
    act(() => hook.result.current.enqueueWrite(data))
    // Queue a marker behind the hook's actual write and completion callback.
    await new Promise<void>((resolve) => term.write('', resolve))
  }
  return { term, write, hook }
}

function readingLine(term: Terminal) {
  return term.buffer.active
    .getLine(term.buffer.active.viewportY)
    ?.translateToString(true)
}

describe('useATermWriteQueue viewport following', () => {
  it('keeps the same history row visible while new output arrives', async () => {
    const { term, write } = await setup()
    term.scrollToLine(8)
    const before = readingLine(term)

    await write('\r\nnew output 1\r\nnew output 2')
    await write('\r\nnew output 3')

    expect(term.buffer.active.viewportY).toBe(8)
    expect(readingLine(term)).toBe(before)
  })

  it('follows output at bottom, pauses after scrolling up, and resumes at bottom', async () => {
    const { term, write } = await setup()
    await write('\r\nfollowing')
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)

    term.scrollLines(-1)
    const before = readingLine(term)
    await write('\r\npaused')
    expect(readingLine(term)).toBe(before)

    term.scrollToBottom()
    await write('\r\nresumed')
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })

  it('preserves the visible history content when the scrollback buffer trims', async () => {
    const { term, write } = await setup(30)
    term.scrollToLine(8)
    const before = readingLine(term)

    await write(
      Array.from({ length: 12 }, (_, index) => `\r\nnew ${index}`).join(''),
    )

    expect(readingLine(term)).toBe(before)
    expect(term.buffer.active.viewportY).toBeLessThan(8)
  })

  it('respects a reader returning to bottom before an asynchronous write finishes', async () => {
    const { term, hook } = await setup()
    term.scrollToLine(8)
    act(() => hook.result.current.enqueueWrite('\r\nnew output'))
    term.scrollToBottom()

    await waitFor(() => {
      expect(
        term.buffer.active
          .getLine(term.buffer.active.baseY + 4)
          ?.translateToString(true),
      ).toBe('new output')
    })

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })

  it('keeps shell history still during a sync and accepts fresh syncs after returning to bottom', async () => {
    const { term, hook, write } = await setup()
    term.scrollToLine(8)
    const before = readingLine(term)
    const snapshot = `${Array.from({ length: 32 }, (_, index) => `history ${index}`).join('\r\n')}\r\n`

    act(() => hook.result.current.applySnapshot(snapshot))
    await new Promise<void>((resolve) => term.write('', resolve))

    expect(term.buffer.active.viewportY).toBe(8)
    expect(readingLine(term)).toBe(before)

    // Raw output continues filling the live terminal while the reader pauses.
    await write('\r\nnew output')
    expect(readingLine(term)).toBe(before)
    term.scrollToBottom()
    act(() => hook.result.current.applySnapshot(snapshot))
    await new Promise<void>((resolve) => term.write('', resolve))
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    expect(term.buffer.active.getLine(31)?.translateToString(true)).toBe(
      'history 31',
    )
  })

  it('retains queued live output when the reader scrolls up before a queued sync', async () => {
    const { term, hook } = await setup()
    act(() => {
      hook.result.current.enqueueWrite('\r\nnew 1')
      hook.result.current.enqueueWrite('\r\nnew 2')
      hook.result.current.applySnapshot('replacement sync\r\n')
    })
    term.scrollToLine(8)
    const before = readingLine(term)

    await waitFor(() => {
      expect(
        term.buffer.active
          .getLine(term.buffer.active.baseY + 4)
          ?.translateToString(true),
      ).toBe('new 2')
    })
    expect(readingLine(term)).toBe(before)
  })

  describe('control-mode repaint (a seed starts with a full terminal reset)', () => {
    const seed = `\x1bc${Array.from({ length: 40 }, (_, index) => `seeded ${index}`).join('\r\n')}`

    async function setupReseed(available = true) {
      const request = vi.fn()
      const base = await setup()
      const hook = renderHook(() =>
        useATermWriteQueue({
          aTermRef: { current: base.term },
          isVisibleRef: { current: true },
          reseed: { available: () => available, request },
        }),
      )
      const write = async (data: string) => {
        act(() => hook.result.current.enqueueWrite(data))
        await new Promise<void>((resolve) => base.term.write('', resolve))
      }
      return { term: base.term, hook, write, request }
    }

    it('keeps the reader in place through a repaint and asks for it again at the bottom', async () => {
      const { term, hook, write, request } = await setupReseed()
      term.scrollToLine(8)
      const before = readingLine(term)

      await write(seed)
      await write('\r\nlive after the seed')

      expect(term.buffer.active.viewportY).toBe(8)
      expect(readingLine(term)).toBe(before)
      expect(request).not.toHaveBeenCalled()

      term.scrollToBottom()
      act(() => hook.result.current.onViewportMoved())
      expect(request).toHaveBeenCalledTimes(1)

      // The server's repaint now lands on the live terminal.
      await write(seed)
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
        'seeded 0',
      )
      expect(request).toHaveBeenCalledTimes(1)
    })

    it('still writes the output that came before the reset in the same chunk', async () => {
      const { term, write } = await setupReseed()
      term.scrollToLine(8)
      const before = readingLine(term)

      await write(`\r\nbefore the reset${seed}`)

      expect(readingLine(term)).toBe(before)
      term.scrollToBottom()
      expect(
        term.buffer.active
          .getLine(term.buffer.active.baseY + 4)
          ?.translateToString(true),
      ).toBe('before the reset')
    })

    it('asks for the repaint when output arrives after the reader is back at the bottom', async () => {
      const { term, write, request } = await setupReseed()
      term.scrollToLine(8)
      await write(seed)
      term.scrollToBottom()

      await write('\r\nnext output')

      expect(request).toHaveBeenCalledTimes(1)
    })

    it('applies a reset at once when the reader is at the bottom', async () => {
      const { term, write, request } = await setupReseed()

      await write(seed)

      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
        'seeded 0',
      )
      expect(request).not.toHaveBeenCalled()
    })

    it('applies a reset when the stream cannot be repainted on request', async () => {
      const { term, write, request } = await setupReseed(false)
      term.scrollToLine(8)

      await write(seed)

      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
        'seeded 0',
      )
      expect(request).not.toHaveBeenCalled()
    })

    it('keeps a reader in history across a reconnect and clears the terminal otherwise', async () => {
      const { term, hook, request } = await setupReseed()
      term.scrollToLine(8)
      const before = readingLine(term)

      act(() => hook.result.current.restartStream())
      expect(readingLine(term)).toBe(before)
      term.scrollToBottom()
      act(() => hook.result.current.onViewportMoved())
      expect(request).toHaveBeenCalledTimes(1)

      act(() => hook.result.current.restartStream())
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('')
    })
  })
})
