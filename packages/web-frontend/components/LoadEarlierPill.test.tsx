import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LoadEarlierPill } from './LoadEarlierPill'

type Listener = () => void

function makeTerm(viewportY = 0) {
  const scroll = new Set<Listener>()
  const subscribe = (set: Set<Listener>) => (fn: Listener) => {
    set.add(fn)
    return { dispose: () => set.delete(fn) }
  }
  const term = {
    buffer: { active: { type: 'normal', baseY: 1995, viewportY } },
    onScroll: subscribe(scroll),
    onWriteParsed: subscribe(new Set<Listener>()),
    onResize: subscribe(new Set<Listener>()),
  }
  const scrollTo = (y: number) =>
    act(() => {
      term.buffer.active.viewportY = y
      for (const fn of scroll) fn()
    })
  return { term, scrollTo }
}

function mount(
  term: ReturnType<typeof makeTerm>['term'],
  props: Partial<React.ComponentProps<typeof LoadEarlierPill>> = {},
) {
  const ref = createRef<never>() as { current: unknown }
  ref.current = term
  const onLoad = vi.fn()
  const view = render(
    <LoadEarlierPill
      terminalRef={ref as never}
      isReady
      history={{ lines: 2000, total: 20000 }}
      step={5000}
      loading={false}
      onLoad={onLoad}
      {...props}
    />,
  )
  return { ...view, onLoad }
}

describe('LoadEarlierPill', () => {
  it('shows at the top of a shortened history and loads more on tap', () => {
    const { term } = makeTerm(0)
    const { onLoad } = mount(term)
    const button = screen.getByRole('button', {
      name: 'Showing the last 2,000 of 20,000 lines. Load 5,000 earlier lines.',
    })
    expect(button).toHaveTextContent('Load earlier')
    fireEvent.click(button)
    expect(onLoad).toHaveBeenCalledOnce()
  })

  it('stays out of the way below the top', () => {
    const { term, scrollTo } = makeTerm(500)
    mount(term)
    expect(screen.queryByRole('button')).toBeNull()
    scrollTo(0)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('is hidden when the whole history is loaded or not known yet', () => {
    const { term } = makeTerm(0)
    const { rerender } = mount(term, {
      history: { lines: 20000, total: 20000 },
    })
    expect(screen.queryByRole('button')).toBeNull()
    rerender(
      <LoadEarlierPill
        terminalRef={{ current: term } as never}
        isReady
        history={null}
        step={5000}
        loading={false}
        onLoad={() => {}}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers only what is left, and says when it is loading', () => {
    const { term } = makeTerm(0)
    const { rerender } = mount(term, {
      history: { lines: 18000, total: 20000 },
    })
    expect(
      screen.getByRole('button', {
        name: 'Showing the last 18,000 of 20,000 lines. Load 2,000 earlier lines.',
      }),
    ).toBeEnabled()
    rerender(
      <LoadEarlierPill
        terminalRef={{ current: term } as never}
        isReady
        history={{ lines: 18000, total: 20000 }}
        step={5000}
        loading
        onLoad={() => {}}
      />,
    )
    const busy = screen.getByRole('button', { name: 'Loading earlier lines' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveTextContent('Loading…')
  })

  it('is hidden under a full-screen program', () => {
    const { term } = makeTerm(0)
    term.buffer.active.type = 'alternate'
    mount(term)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
