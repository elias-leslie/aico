import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '@/lib/utils/slot'
import { ResizablePaneLayout } from './ResizablePaneLayout'

vi.mock('@/lib/hooks/pane-layout', () => ({
  useMinSizeCalculator: () => () => 20,
  usePaneRenderer: () => () => <div data-testid="pane-body" />,
  useLayoutChangeHandler: () => vi.fn(),
}))

vi.mock('./pane-layouts', () => ({
  EmptyPaneState: () => <div data-testid="empty-pane-state" />,
  SinglePaneLayout: () => <div data-testid="single-pane-layout" />,
  LinearPaneLayout: ({
    orientation,
  }: {
    orientation?: 'horizontal' | 'vertical'
  }) => <div data-testid={`linear-pane-${orientation ?? 'horizontal'}`} />,
  FourPaneLayout: () => <div data-testid="four-pane-layout" />,
  WidePaneLayout: ({
    getStoredGroupLayout,
  }: {
    getStoredGroupLayout: (
      groupId: string,
      panelCount: number,
      defaultSize: number,
    ) => number[]
  }) => (
    <div data-testid="wide-pane-layout">
      <span data-testid="wide-root">
        {getStoredGroupLayout('wide-pane-root', 2, 50).join(',')}
      </span>
      <span data-testid="wide-top-row">
        {getStoredGroupLayout('wide-pane-top-row', 3, 100 / 3).join(',')}
      </span>
    </div>
  ),
}))

function makeProjectSlot(id: string): PaneSlot {
  return {
    type: 'project',
    paneId: `pane-${id}`,
    projectId: `project-${id}`,
    projectName: `Project ${id}`,
    rootPath: `/tmp/project-${id}`,
    activeMode: 'shell',
    activeSessionId: `session-${id}`,
    sessionBadge: null,
  }
}

describe('ResizablePaneLayout', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('uses the vertical split for stacked two-pane mode', () => {
    render(
      <ResizablePaneLayout
        slots={[makeProjectSlot('1'), makeProjectSlot('2')]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="split-vertical"
      />,
    )

    expect(screen.getByTestId('linear-pane-vertical')).toBeInTheDocument()
  })

  it('uses the wide grid when more than four panes are present', () => {
    render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
          makeProjectSlot('5'),
          makeProjectSlot('6'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="grid-3x2"
      />,
    )

    expect(screen.getByTestId('wide-pane-layout')).toBeInTheDocument()
  })

  it('uses the side-by-side linear layout for four panes', () => {
    render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="split-horizontal"
      />,
    )

    expect(screen.getByTestId('linear-pane-horizontal')).toBeInTheDocument()
  })

  it('uses the balanced four-pane grid when grid mode is selected', () => {
    render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="grid-2x2"
      />,
    )

    expect(screen.getByTestId('four-pane-layout')).toBeInTheDocument()
  })

  it('uses the vertical split for stacked three-pane mode', () => {
    render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="split-vertical"
      />,
    )

    expect(screen.getByTestId('linear-pane-vertical')).toBeInTheDocument()
  })

  it('uses the side-by-side linear layout for six panes', () => {
    render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
          makeProjectSlot('5'),
          makeProjectSlot('6'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="split-horizontal"
      />,
    )

    expect(screen.getByTestId('linear-pane-horizontal')).toBeInTheDocument()
  })

  it('switches to the correct wide-layout storage bucket when pane count changes', () => {
    window.localStorage.setItem(
      'a-term-layout-groups:grid-3x2:5',
      JSON.stringify({
        'wide-pane-root': [70, 30],
      }),
    )
    window.localStorage.setItem(
      'a-term-layout-groups:grid-3x2:6',
      JSON.stringify({
        'wide-pane-root': [45, 55],
      }),
    )

    const { rerender } = render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
          makeProjectSlot('5'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="grid-3x2"
      />,
    )

    expect(screen.getByTestId('wide-root')).toHaveTextContent('70,30')

    rerender(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
          makeProjectSlot('5'),
          makeProjectSlot('6'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="grid-3x2"
      />,
    )

    expect(screen.getByTestId('wide-root')).toHaveTextContent('45,55')
  })

  it('normalizes stale wide row sizes so screenshots do not leave empty gaps', () => {
    window.localStorage.setItem(
      'a-term-layout-groups:grid-3x2:5',
      JSON.stringify({
        'wide-pane-top-row': [25, 25, 25],
      }),
    )

    render(
      <ResizablePaneLayout
        slots={[
          makeProjectSlot('1'),
          makeProjectSlot('2'),
          makeProjectSlot('3'),
          makeProjectSlot('4'),
          makeProjectSlot('5'),
        ]}
        fontFamily="monospace"
        fontSize={14}
        layoutMode="grid-3x2"
      />,
    )

    const sizes =
      screen.getByTestId('wide-top-row').textContent?.split(',').map(Number) ??
      []

    expect(sizes).toHaveLength(3)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(100)
    expect(sizes[0]).toBeCloseTo(100 / 3)
  })
})
