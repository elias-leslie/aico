import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useScrollbackATerm } from './use-scrollback-a-term'

const fitMock = {
  fit: vi.fn(),
}

class FakeTerminal {
  static instances: FakeTerminal[] = []

  rows = 24
  buffer = {
    active: {
      baseY: 10,
      viewportY: 10,
    },
  }
  loadAddon = vi.fn()
  open = vi.fn()
  dispose = vi.fn()
  clearSelection = vi.fn()
  reset = vi.fn()
  refresh = vi.fn()
  scrollLines = vi.fn((lineDelta: number) => {
    this.buffer.active.viewportY = Math.max(
      0,
      Math.min(
        this.buffer.active.baseY,
        this.buffer.active.viewportY + lineDelta,
      ),
    )
  })
  scrollToBottom = vi.fn(() => {
    this.buffer.active.viewportY = this.buffer.active.baseY
  })
  scrollToLine = vi.fn((line: number) => {
    this.buffer.active.viewportY = line
  })
  write = vi.fn((data: string, callback?: () => void) => {
    const lines = data.split('\r\n').filter(Boolean)
    this.buffer.active.baseY = Math.max(lines.length - 1, 0)
    if (this.buffer.active.viewportY > this.buffer.active.baseY) {
      this.buffer.active.viewportY = this.buffer.active.baseY
    }
    callback?.()
  })

  constructor() {
    FakeTerminal.instances.push(this)
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: FakeTerminal,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FakeFitAddon {
    fit = fitMock.fit
  },
}))

vi.mock('../utils/mobile-a-term-touch', () => ({
  applyMobileATermTouchStyles: vi.fn(),
}))

type HarnessProps = Parameters<typeof useScrollbackATerm>[0]

function HookHarness(
  props: HarnessProps & {
    expose: (value: ReturnType<typeof useScrollbackATerm>) => void
  },
) {
  const hook = useScrollbackATerm(props)

  useEffect(() => {
    props.expose(hook)
  }, [hook, props])

  return <div ref={hook.containerRef} data-testid="overlay-container" />
}

describe('useScrollbackATerm', () => {
  it('defers overlay rewrites while the reader is scrolled up and flushes them at bottom', async () => {
    let latestHook: ReturnType<typeof useScrollbackATerm> | null = null
    const expose = (value: ReturnType<typeof useScrollbackATerm>) => {
      latestHook = value
    }

    const baseProps: HarnessProps = {
      isActive: true,
      lines: ['line-1', 'line-2'],
      initialScrollLineDelta: 0,
      searchQuery: '',
      searchActiveIndex: -1,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#00ff9f',
        cursorAccent: '#000000',
        selectionBackground: '#224433',
        black: '#000000',
        red: '#ff5555',
        green: '#00ff9f',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f8fafc',
        brightBlack: '#94a3b8',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      fontFamily: 'monospace',
      fontSize: 14,
    }

    const { rerender } = render(<HookHarness {...baseProps} expose={expose} />)

    await waitFor(() => {
      expect(FakeTerminal.instances.length).toBeGreaterThan(0)
      expect(FakeTerminal.instances[0].write).toHaveBeenCalledTimes(1)
    })

    const term = FakeTerminal.instances[0]
    term.buffer.active.baseY = 20
    term.buffer.active.viewportY = 6

    rerender(
      <HookHarness
        {...baseProps}
        lines={['line-1', 'line-2', 'line-3']}
        expose={expose}
      />,
    )

    await waitFor(() => {
      expect(latestHook).not.toBeNull()
    })

    expect(term.reset).toHaveBeenCalledTimes(1)
    expect(term.write).toHaveBeenCalledTimes(1)

    term.buffer.active.viewportY = term.buffer.active.baseY
    latestHook?.flushPendingLines.current(term)

    expect(term.reset).toHaveBeenCalledTimes(2)
    expect(term.write).toHaveBeenCalledTimes(2)
    expect(term.write.mock.calls[1]?.[0]).toBe('line-1\r\nline-2\r\nline-3')
  })
})
