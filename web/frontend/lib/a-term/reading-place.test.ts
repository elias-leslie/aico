import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepReadingPlace } from './reading-place'

vi.hoisted(() => {
  // The real terminal buffer, without a canvas renderer.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

const terminals: Terminal[] = []

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose()
})

async function setup(keep: boolean) {
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 500 })
  terminals.push(term)
  await new Promise<void>((resolve) =>
    term.write(
      Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\r\n'),
      resolve,
    ),
  )
  if (keep) keepReadingPlace(term)
  return term
}

const topLine = (term: Terminal) =>
  term.buffer.active
    .getLine(term.buffer.active.viewportY)
    ?.translateToString(true)

describe('keepReadingPlace', () => {
  it('shows what xterm does without it: fewer rows slide the reader down', async () => {
    const term = await setup(false)
    term.scrollToLine(20)

    term.resize(40, 6)

    expect(topLine(term)).toBe('line 24')
  })

  it.each([4, 14])(
    'keeps the same text on top when the rows change to %i',
    async (rows) => {
      const term = await setup(true)
      term.scrollToLine(20)

      term.resize(40, rows)

      expect(topLine(term)).toBe('line 20')
      expect(term.buffer.active.viewportY).toBeLessThan(
        term.buffer.active.baseY,
      )
    },
  )

  it('keeps following the output after a resize at the bottom', async () => {
    const term = await setup(true)

    term.resize(40, 6)

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })

  it('tracks the reader through scrolling and output', async () => {
    const term = await setup(true)
    term.scrollToLine(30)
    await new Promise<void>((resolve) => term.write('\r\nmore', resolve))
    term.scrollLines(-5)

    term.resize(40, 7)

    expect(topLine(term)).toBe('line 25')
  })
})
