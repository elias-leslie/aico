import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BOTTOM_OVERLAY_HEIGHT_VAR } from '../lib/constants/a-term'
import { ScrollToBottomPill } from './ScrollToBottomPill'

type Listener = () => void

function makeTerm() {
  const listeners = { scroll: new Set<Listener>(), write: new Set<Listener>() }
  const subscribe = (set: Set<Listener>) => (fn: Listener) => {
    set.add(fn)
    return { dispose: () => set.delete(fn) }
  }
  const term = {
    buffer: { active: { baseY: 50, viewportY: 50 } },
    onScroll: subscribe(listeners.scroll),
    onWriteParsed: subscribe(listeners.write),
    onResize: subscribe(new Set<Listener>()),
    scrollToBottom: vi.fn(() => {
      term.buffer.active.viewportY = term.buffer.active.baseY
      for (const fn of listeners.scroll) fn()
    }),
  }
  const emit = (kind: 'scroll' | 'write') => {
    act(() => {
      for (const fn of listeners[kind]) fn()
    })
  }
  return { term, emit }
}

function mount(term: ReturnType<typeof makeTerm>['term']) {
  const ref = createRef<never>() as { current: unknown }
  ref.current = term
  return render(<ScrollToBottomPill aTermRef={ref as never} isReady />)
}

describe('ScrollToBottomPill', () => {
  it('is hidden at the live bottom', () => {
    const { term } = makeTerm()
    mount(term)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('appears when the reader scrolls up and jumps to the bottom on tap', () => {
    const { term, emit } = makeTerm()
    mount(term)

    term.buffer.active.viewportY = 20
    emit('scroll')
    const pill = screen.getByRole('button', { name: 'Jump to latest output' })
    expect(pill).toHaveTextContent('Latest')

    fireEvent.click(pill)
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('lifts above the compose overlay by the height it publishes', () => {
    const { term, emit } = makeTerm()
    mount(term)
    term.buffer.active.viewportY = 20
    emit('scroll')
    const wrapper = screen.getByTestId('a-term-scroll-to-bottom')
    expect(wrapper.style.bottom).toContain(`var(${BOTTOM_OVERLAY_HEIGHT_VAR}`)
  })

  it('says so when output arrives while the reader stays put', () => {
    const { term, emit } = makeTerm()
    mount(term)
    term.buffer.active.viewportY = 20
    emit('scroll')

    term.buffer.active.baseY = 55
    emit('write')
    expect(screen.getByRole('button')).toHaveTextContent('New output')
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(
      /new output/i,
    )

    // Scrolling again is the reader moving, not new output.
    term.buffer.active.viewportY = 10
    emit('scroll')
    expect(screen.getByRole('button')).toHaveTextContent('Latest')
  })

  it('does not take focus from the terminal on press', () => {
    const { term, emit } = makeTerm()
    mount(term)
    term.buffer.active.viewportY = 20
    emit('scroll')
    const pill = screen.getByRole('button')
    const notPrevented = fireEvent.mouseDown(pill)
    expect(notPrevented).toBe(false)
    expect(fireEvent.pointerDown(pill, { pointerType: 'touch' })).toBe(false)
  })

  it('stops listening when unmounted', () => {
    const { term, emit } = makeTerm()
    const view = mount(term)
    view.unmount()
    term.buffer.active.viewportY = 0
    expect(() => emit('scroll')).not.toThrow()
  })
})
