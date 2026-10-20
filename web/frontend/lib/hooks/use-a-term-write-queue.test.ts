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
})
